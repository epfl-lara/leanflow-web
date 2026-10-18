import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// Anchor every lookup to an open directory. A project worker may rename a
// directory during this scan; following its old pathname could leave the root.
// Python's descriptor-relative filesystem API works on Linux and macOS. -I
// prevents a project-local module or PYTHONPATH from changing this host helper.
const script = String.raw`
import hashlib,json,os,stat,sys
files=[]
flags=os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK
def walk(directory,relative=''):
    with os.scandir(directory) as entries:
        for entry in entries:
            if entry.name in {'.lake','.git'}: continue
            name=relative+'/'+entry.name if relative else entry.name
            if entry.is_symlink():
                files.append([name,'link',os.readlink(entry.name,dir_fd=directory)])
            elif entry.is_dir(follow_symlinks=False):
                child=os.open(entry.name,flags|os.O_DIRECTORY,dir_fd=directory)
                try: walk(child,name)
                finally: os.close(child)
            elif entry.is_file(follow_symlinks=False):
                child=os.open(entry.name,flags,dir_fd=directory)
                try:
                    if not stat.S_ISREG(os.fstat(child).st_mode):
                        raise OSError('Project input changed during checking')
                    digest=hashlib.sha256()
                    while True:
                        chunk=os.read(child,1024*1024)
                        if not chunk: break
                        digest.update(chunk)
                    files.append([name,digest.hexdigest()])
                finally: os.close(child)
root=os.open(sys.argv[1],flags|os.O_DIRECTORY)
try: walk(root)
finally: os.close(root)
files.sort(key=lambda entry:entry[0])
print(hashlib.sha256(json.dumps(files,separators=(',',':')).encode()).hexdigest())
`

// Build artifacts are reusable inputs to Lake, never proof certificates.
// Include auxiliary files and link targets, excluding generated Git/Lake state.
export async function sourceFingerprint(root, options = {}) {
  options.signal?.throwIfAborted()
  try {
    const { stdout } = await execute('python3', ['-I', '-c', script, root], {
      maxBuffer: 64 * 1024,
      signal: options.signal,
    })
    const fingerprint = stdout.trim()
    if (/^[a-f0-9]{64}$/.test(fingerprint)) return fingerprint
  } catch {
    options.signal?.throwIfAborted()
    // Filesystem races and permission failures must fail the check without
    // exposing host paths or Python diagnostics in the interface.
  }
  throw new Error(
    'Project inputs changed or could not be read during checking. Save your files and retry.',
  )
}
