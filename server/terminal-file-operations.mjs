import * as fs from 'node:fs/promises'
import childProcess from 'node:child_process'

// These Linux operations need descriptor-relative syscalls that Node does not
// expose. The child inherits only verified directory handles, never a shell.
const program = `import base64, ctypes, errno, fcntl, hashlib, json, os, signal, stat, sys
data = json.load(sys.stdin)
if data['operation'] == 'exchange':
    libc = ctypes.CDLL(None, use_errno=True)
    rename = libc.renameat2
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    source = base64.b64decode(data['from'], validate=True)
    target = base64.b64decode(data['to'], validate=True)
    if rename(3, source, 4, target, 2) != 0:
        print(json.dumps({'error': errno.errorcode.get(ctypes.get_errno(), 'EIO')}))
        sys.exit(1)
    print('{}')
else:
    result = {}
    broken = False
    def lease_broken(*unused):
        global broken
        broken = True
    signal.signal(signal.SIGIO, lease_broken)
    for item in data['files']:
        name = item['name']
        descriptor = None
        leased = False
        broken = False
        try:
            descriptor = os.open(name, os.O_RDWR | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=3)
            before = os.fstat(descriptor)
            if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1:
                result[name] = 'retained'
                continue
            # A write lease is refused for other open descriptors and writable
            # mappings. With one hard link, this protected inode has no worker-
            # accessible name once the kernel proves no writer still holds it.
            fcntl.fcntl(descriptor, fcntl.F_SETLEASE, fcntl.F_WRLCK)
            leased = True
            digest = hashlib.sha256()
            size = 0
            while True:
                chunk = os.read(descriptor, 65536)
                if not chunk: break
                size += len(chunk)
                if size > data['maxBytes']: break
                digest.update(chunk)
            if size > data['maxBytes'] or digest.hexdigest() != item['hash']:
                result[name] = 'changed'
                continue
            current = os.stat(name, dir_fd=3, follow_symlinks=False)
            if broken or current.st_nlink != 1 or (current.st_dev, current.st_ino) != (before.st_dev, before.st_ino) or fcntl.fcntl(descriptor, fcntl.F_GETLEASE) != fcntl.F_WRLCK:
                result[name] = 'retained'
                continue
            os.unlink(name, dir_fd=3)
            result[name] = 'removed'
        except FileNotFoundError:
            result[name] = 'removed'
        except OSError:
            # Permission errors, unsupported leases and a live writer retain
            # the inode. No /proc visibility or expiry heuristic is assumed.
            result[name] = 'retained'
        finally:
            if descriptor is not None:
                if leased:
                    try: fcntl.fcntl(descriptor, fcntl.F_SETLEASE, fcntl.F_UNLCK)
                    except OSError: pass
                os.close(descriptor)
    os.fsync(3)
    print(json.dumps(result))
`

async function operation(data, handles) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn('python3', ['-I', '-c', program], {
      env: { PATH: process.env.PATH, LC_ALL: 'C' },
      stdio: ['pipe', 'pipe', 'ignore', ...handles.map((handle) => handle.fd)],
      signal: AbortSignal.timeout(10_000),
    })
    let output = ''
    let failure
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (output.length < 1024 * 1024) output += chunk
    })
    child.once('error', (error) => {
      failure = error
    })
    child.once('close', (code) => {
      if (failure || code !== 0)
        return reject(
          Object.assign(
            new Error(
              'Terminal file reconciliation could not finish safely. Close this terminal and recover its private copy before reopening it.',
            ),
            { status: 409 },
          ),
        )
      try {
        resolve(JSON.parse(output))
      } catch {
        reject(new Error('Invalid terminal reconciliation response.'))
      }
    })
    child.stdin.on('error', () => {})
    child.stdin.end(JSON.stringify(data))
  })
}

export async function exchangeTerminalFiles(source, target) {
  const sourcePath = `${source.anchor}/${source.name}`
  const targetPath = `${target.anchor}/${target.name}`
  const [staged, previous] = await Promise.all([
    fs.lstat(sourcePath),
    fs.lstat(targetPath),
  ])
  try {
    await operation(
      {
        operation: 'exchange',
        from: Buffer.from(source.name).toString('base64'),
        to: Buffer.from(target.name).toString('base64'),
      },
      [source.handle, target.handle],
    )
  } catch (error) {
    // A helper can finish the exchange before an abort/error is delivered.
    const [old, current] = await Promise.all([
      fs.lstat(sourcePath).catch(() => null),
      fs.lstat(targetPath).catch(() => null),
    ])
    if (
      old?.ino === previous.ino &&
      old.dev === previous.dev &&
      current?.ino === staged.ino &&
      current.dev === staged.dev
    )
      return
    throw error
  }
}

export function compactTerminalFiles(parent, files, maxBytes) {
  return operation({ operation: 'compact', files, maxBytes }, [parent.handle])
}
