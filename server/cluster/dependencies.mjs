import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { dependencyPackageDirectory } from '../project-libraries.mjs'
import { captureTree, MAX_ENTRIES, MAX_MANIFEST } from './blobs.mjs'
import { clusterError } from './state.mjs'
import { pythonBudget } from './budget.mjs'
import { sharedDependencyCacheSchema } from '../shared-dependencies.mjs'

const execute = promisify(execFile)

export async function capturePreparedDependencies(
  store,
  root,
  { dataDir, version, signal } = {},
) {
  const parent = path.join(dataDir, 'runtime/shared-dependencies')
  if (
    !path.isAbsolute(root) ||
    path.dirname(root) !== parent ||
    !/^[a-f0-9]{64}$/.test(path.basename(root)) ||
    (await fs.realpath(root)) !== root
  )
    throw clusterError(
      'Select a prepared, server-managed dependency directory.',
    )
  const marker = path.join(root, '.ready.json')
  const pin = path.join(root, 'lean-toolchain')
  for (const [filename, maxBytes] of [
    [marker, 65536],
    [pin, 1024],
  ]) {
    const stat = await fs.lstat(filename)
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > maxBytes ||
      stat.mode & 0o022
    )
      throw clusterError('The prepared dependency metadata is not protected.')
  }
  const ready = JSON.parse(await fs.readFile(marker, 'utf8'))
  if (
    ready.schema !== sharedDependencyCacheSchema ||
    ready.key !== path.basename(root) ||
    (await fs.readFile(pin, 'utf8')).trim() !== version
  )
    throw clusterError(
      'Prepare the current dependency cache for this pinned toolchain first.',
    )
  return captureDependencies(store, root, { signal })
}

// Export only the locked commit and its reachable tree, with a fresh index and
// fixed configuration. Original Git configs, hooks, alternates, reflogs and
// unrelated history never enter the object store. No Git operation uses a
// network or invokes a project hook/filter.
const gitSnapshotScript = String.raw`
import hashlib,json,os,signal,stat,subprocess,sys,tempfile,zlib
root,objects,records,reserve,budget_filename,max_bytes,max_files=sys.argv[1:]
records=json.loads(records);reserve=int(reserve)
max_bytes=int(max_bytes);max_files=int(max_files)
${pythonBudget}
def interrupted(signum,frame):raise InterruptedError('Dependency snapshot stopped')
signal.signal(signal.SIGTERM,interrupted)
env={k:v for k,v in os.environ.items() if not k.startswith('GIT_')}
env.update(GIT_CONFIG_NOSYSTEM='1',GIT_CONFIG_GLOBAL='/dev/null',GIT_OPTIONAL_LOCKS='0',GIT_TERMINAL_PROMPT='0')
entries=[];directories=set()
def put(name,data):
 if len(entries)>=${MAX_ENTRIES} or len(data)>64*1024**2:raise ValueError('Dependency metadata exceeds its bound')
 space=os.statvfs(objects)
 if space.f_bavail*space.f_frsize-len(data)<reserve:raise OSError('Worker storage reserve reached')
 h=hashlib.sha256(data).hexdigest();target=os.path.join(objects,h)
 reserve_blob(h,len(data))
 if not os.path.exists(target):
  fd,temporary=tempfile.mkstemp(prefix='.git-capture-',dir=objects)
  try:
   with os.fdopen(fd,'wb') as out:
    out.write(data);out.flush();os.fsync(out.fileno());os.fchmod(out.fileno(),0o400)
   os.replace(temporary,target)
  finally:
   if os.path.exists(temporary):os.unlink(temporary)
 entries.append(dict(path=name,type='file',hash=h,size=len(data),mode=0o600))
 directory=os.path.dirname(name)
 while directory:
  directories.add(directory);directory=os.path.dirname(directory)
for record in records:
 name,head,url=record['directory'],record['head'],record['url']
 checkout=os.path.join(root,name)
 gitdir=os.path.join(checkout,'.git')
 if os.path.realpath(checkout)!=checkout or not stat.S_ISDIR(os.lstat(gitdir).st_mode) or os.path.islink(gitdir):raise ValueError('Public dependency must have its own real Git directory')
 command=['git','--git-dir='+gitdir,'--work-tree='+checkout,'-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','credential.helper=']
 def git(args,**kwargs):return subprocess.run(command+args,env=env,check=True,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=120,**kwargs).stdout
 if git(['rev-parse','--verify','HEAD']).decode().strip()!=head:raise ValueError('Dependency HEAD differs from its lockfile')
 tree=git(['rev-parse',head+'^{tree}']).decode().strip()
 object_ids=[head]+git(['rev-list','--objects','--no-object-names',tree]).decode().splitlines()
 if len(object_ids)>${MAX_ENTRIES}:raise ValueError('Too many dependency objects')
 process=subprocess.Popen(command+['cat-file','--batch'],env=env,stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.DEVNULL)
 try:
  for oid in dict.fromkeys(object_ids):
   if len(oid)!=40 or any(c not in '0123456789abcdef' for c in oid):raise ValueError('Invalid dependency object')
   process.stdin.write((oid+'\n').encode());process.stdin.flush()
   fields=process.stdout.readline(256).decode().strip().split()
   if len(fields)!=3 or fields[0]!=oid or fields[1] not in ('commit','tree','blob'):raise ValueError('Invalid dependency object header')
   size=int(fields[2])
   if size<0 or size>64*1024**2:raise ValueError('Dependency object exceeds its bound')
   data=process.stdout.read(size)
   if len(data)!=size or process.stdout.read(1)!=b'\n':raise ValueError('Truncated dependency object')
   raw=(fields[1]+' '+str(size)).encode()+b'\0'+data
   if hashlib.sha1(raw).hexdigest()!=oid:raise ValueError('Dependency Git object checksum differs')
   put(name+'/.git/objects/'+oid[:2]+'/'+oid[2:],zlib.compress(raw))
 finally:
  process.stdin.close();process.stdout.close()
  try:process.wait(timeout=5)
  except subprocess.TimeoutExpired:process.kill();process.wait()
 prefix=name+'/.git/'
 directories.update([name,prefix[:-1],prefix+'objects',prefix+'refs'])
 put(prefix+'HEAD',(head+'\n').encode())
 put(prefix+'shallow',(head+'\n').encode())
 put(prefix+'config',('[core]\n repositoryformatversion = 0\n bare = false\n filemode = true\n[remote "origin"]\n url = '+url+'\n').encode())
 with tempfile.TemporaryDirectory(prefix='leanflow-git-index-') as temporary:
  index=os.path.join(temporary,'index');env['GIT_INDEX_FILE']=index
  git(['read-tree',head])
  with open(index,'rb') as stream:put(prefix+'index',stream.read(64*1024**2+1))
  del env['GIT_INDEX_FILE']
entries=[dict(path=name,type='directory') for name in sorted(directories)]+entries
print(json.dumps(entries,separators=(',',':'),ensure_ascii=True))
`

export async function captureDependencies(store, environment, { signal } = {}) {
  const packages = path.join(environment, '.lake/packages')
  const manifest = JSON.parse(
    await fs.readFile(path.join(environment, 'lake-manifest.json'), 'utf8'),
  )
  if (!Array.isArray(manifest.packages) || manifest.packages.length > 100)
    throw clusterError('Invalid public dependency lockfile.')
  const seen = new Set()
  const records = manifest.packages.map((pkg) => {
    const directory = dependencyPackageDirectory(pkg?.name)
    if (
      !directory ||
      seen.has(directory) ||
      pkg.type !== 'git' ||
      !/^[a-f0-9]{40}$/.test(pkg.rev) ||
      pkg.subDir
    )
      throw clusterError(
        'Only locked public Git dependencies can be transferred.',
      )
    seen.add(directory)
    const url = new URL(pkg.url)
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      /[\s"\\]/.test(pkg.url)
    )
      throw clusterError('Invalid public dependency URL.')
    return { directory, head: pkg.rev, url: pkg.url }
  })
  const captured = await captureTree(store, packages, {
    kind: 'dependencies',
    signal,
  })
  const entries = new Map(
    captured.manifest.entries.map((entry) => [
      '.lake/packages/' + entry.path,
      { ...entry, path: '.lake/packages/' + entry.path },
    ]),
  )
  entries.set('.lake', { path: '.lake', type: 'directory' })
  entries.set('.lake/packages', { path: '.lake/packages', type: 'directory' })
  let generated = []
  if (records.length) {
    const { stdout } = await execute(
      'python3',
      [
        '-I',
        '-c',
        gitSnapshotScript,
        packages,
        store.objects,
        JSON.stringify(records),
        String(store.reserveBytes),
        store.budget.filename,
        String(store.maxBytes),
        String(store.maxFiles),
      ],
      { signal, timeout: 30 * 60 * 1000, maxBuffer: MAX_MANIFEST },
    )
    generated = JSON.parse(stdout).map((entry) => ({
      ...entry,
      path: '.lake/packages/' + entry.path,
    }))
  }
  const cacheRoot = path.join(environment, '.dependency-lake-cache')
  try {
    const stat = await fs.lstat(cacheRoot)
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw clusterError('The shared artifact cache must be a real directory.')
    const cache = await captureTree(store, cacheRoot, {
      kind: 'dependencies',
      signal,
    })
    generated.push(
      { path: '.dependency-lake-cache', type: 'directory' },
      ...cache.manifest.entries.map((entry) => ({
        ...entry,
        path: '.dependency-lake-cache/' + entry.path,
      })),
    )
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  for (const entry of generated) {
    const prior = entries.get(entry.path)
    if (prior && prior.type !== 'directory')
      throw clusterError(
        'Generated dependency metadata conflicts with its source.',
      )
    entries.set(entry.path, entry)
  }
  const directory = await fs.open(store.objects, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
  return {
    ...(await store.seal(
      [...entries.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
      'dependencies',
    )),
  }
}
