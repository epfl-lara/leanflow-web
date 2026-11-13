import fs from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { clusterError, digest } from './state.mjs'

// Private coordinator metadata only. Paths never enter snapshot manifests or
// the worker protocol. Only managed assets register sources; identical content
// in any snapshot can share the same content-addressed bytes.
export class AssetSources {
  constructor(directory, dataDir, maxFiles, publicPath) {
    this.filename = path.join(directory, 'asset-sources.sqlite')
    this.dataDir = dataDir
    this.maxFiles = maxFiles
    this.db = null
    if (typeof publicPath !== 'function')
      throw clusterError('Managed asset sources need a path policy.')
    this.publicPath = publicPath
  }

  async init() {
    if (
      !path.isAbsolute(this.dataDir) ||
      (await fs.realpath(this.dataDir)) !== this.dataDir
    )
      throw clusterError(
        'Managed asset storage needs a real coordinator directory.',
      )
    try {
      const stat = await fs.lstat(this.filename)
      if (
        !stat.isFile() ||
        stat.nlink !== 1 ||
        stat.uid !== process.getuid() ||
        stat.mode & 0o077
      )
        throw clusterError('Invalid managed asset index.')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    this.db = new DatabaseSync(this.filename)
    await fs.chmod(this.filename, 0o600)
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=30000;
      CREATE TABLE IF NOT EXISTS asset_sources (
        hash TEXT PRIMARY KEY, root TEXT NOT NULL, kind TEXT NOT NULL,
        filename TEXT NOT NULL, size INTEGER NOT NULL, device TEXT NOT NULL,
        inode TEXT NOT NULL, modified TEXT NOT NULL, changed TEXT NOT NULL
      );`)
    return this
  }

  #root(root, kind) {
    if (
      typeof root !== 'string' ||
      !path.isAbsolute(root) ||
      path.normalize(root) !== root
    )
      return false
    const relative = path.relative(path.join(this.dataDir, 'runtime'), root)
    return kind === 'toolchain'
      ? /^elan\/toolchains\/leanprover--lean4---v\d+\.\d+\.\d+(?:-(?:rc\d+|nightly-[0-9-]+))?$/.test(
          relative,
        )
      : kind === 'dependencies' &&
          /^shared-dependencies\/[a-f0-9]{64}\/(?:\.lake\/packages|\.dependency-lake-cache)$/.test(
            relative,
          )
  }

  async captureRoot(root, kind) {
    if (!this.#root(root, kind)) return null
    const stat = await fs.lstat(root)
    if (
      !stat.isDirectory() ||
      stat.uid !== process.getuid() ||
      stat.mode & 0o022 ||
      (await fs.realpath(root)) !== root
    )
      throw clusterError('The managed asset directory is not protected.')
    if (kind === 'dependencies') {
      const environment = root.endsWith('/.lake/packages')
        ? path.dirname(path.dirname(root))
        : path.dirname(root)
      const marker = path.join(environment, '.ready.json')
      const metadata = await fs.lstat(marker)
      if (
        !metadata.isFile() ||
        metadata.nlink !== 1 ||
        metadata.uid !== process.getuid() ||
        metadata.mode & 0o022 ||
        metadata.size > 65536
      )
        throw clusterError('The managed asset certificate is not protected.')
      const ready = JSON.parse(await fs.readFile(marker, 'utf8'))
      // Legacy immutable assets may be indexed for space reclamation. The
      // existing CheckInputs eligibility check still excludes legacy caches.
      if (
        ![5, 6].includes(ready.schema) ||
        ready.key !== path.basename(environment)
      )
        throw clusterError('The managed asset certificate is invalid.')
    }
    return this.filename
  }

  #matches(stat, row) {
    return (
      stat.isFile() &&
      stat.nlink === 1n &&
      stat.uid === BigInt(process.getuid()) &&
      !(stat.mode & 0o022n) &&
      String(stat.size) === String(row.size) &&
      String(stat.dev) === row.device &&
      String(stat.ino) === row.inode &&
      String(stat.mtimeNs) === row.modified &&
      String(stat.ctimeNs) === row.changed
    )
  }

  async open(hash) {
    const row = this.db
      .prepare('SELECT * FROM asset_sources WHERE hash=?')
      .get(digest(hash))
    if (
      !row ||
      !this.#root(row.root, row.kind) ||
      !row.filename.startsWith(row.root + path.sep) ||
      path.normalize(row.filename) !== row.filename ||
      !this.publicPath(path.relative(row.root, row.filename))
    )
      return null
    let handle
    try {
      if ((await fs.realpath(row.filename)) !== row.filename) return null
      handle = await fs.open(
        row.filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      const stat = await handle.stat({ bigint: true })
      if (!this.#matches(stat, row)) {
        await handle.close()
        return null
      }
      const validate = async () => {
        if (!this.#matches(await handle.stat({ bigint: true }), row))
          throw clusterError(
            'A managed runtime asset changed during transfer.',
            'asset_changed',
            409,
          )
      }
      return {
        handle,
        filename: row.filename,
        size: Number(stat.size),
        backed: true,
        validate,
      }
    } catch (error) {
      await handle?.close()
      if (['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)) return null
      throw error
    }
  }

  *hashes() {
    for (const row of this.db
      .prepare('SELECT hash FROM asset_sources')
      .iterate())
      yield row.hash
  }

  usage() {
    return {
      ...this.db
        .prepare(
          'SELECT COUNT(*) AS files, COALESCE(SUM(size),0) AS bytes FROM asset_sources',
        )
        .get(),
      maxFiles: this.maxFiles,
    }
  }

  reset() {
    this.db.exec('DELETE FROM asset_sources; PRAGMA wal_checkpoint(TRUNCATE);')
  }
  close() {
    this.db?.close()
    this.db = null
  }
}

export const pythonAssetSources = String.raw`
source_rows=tempfile.TemporaryFile(mode='w+t',encoding='utf8',dir=os.path.dirname(sources_filename)) if sources_filename else None
def reference_source(relative,actual,hash,size):
 if source_rows is None or actual.st_nlink!=1 or actual.st_uid!=os.getuid() or actual.st_mode&0o022:return False
 row=[hash,root,kind,os.path.join(root,relative),size,str(actual.st_dev),str(actual.st_ino),str(actual.st_mtime_ns),str(actual.st_ctime_ns)]
 text=json.dumps(row,separators=(',',':'))+'\n'
 space=os.statvfs(objects)
 if space.f_bavail*space.f_frsize-len(text.encode())<reserve:raise OSError('Worker storage reserve reached')
 source_rows.write(text)
 return True
def publish_sources():
 if source_rows is None:return
 source_rows.seek(0)
 connection=sqlite3.connect(sources_filename,timeout=30)
 connection.execute('PRAGMA synchronous=FULL')
 try:
  while True:
   batch=[]
   for _ in range(2048):
    line=source_rows.readline()
    if not line:break
    batch.append(json.loads(line))
   if not batch:break
   connection.execute('BEGIN IMMEDIATE')
   try:
    connection.executemany('INSERT INTO asset_sources VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(hash) DO UPDATE SET root=excluded.root,kind=excluded.kind,filename=excluded.filename,size=excluded.size,device=excluded.device,inode=excluded.inode,modified=excluded.modified,changed=excluded.changed',batch)
    if connection.execute('SELECT COUNT(*) FROM asset_sources').fetchone()[0]>max_sources:raise OSError('Managed asset index budget reached')
    space=os.statvfs(objects)
    if space.f_bavail*space.f_frsize<reserve:raise OSError('Worker storage reserve reached')
    connection.commit()
   except BaseException:connection.rollback();raise
 finally:connection.close();source_rows.close()
`
