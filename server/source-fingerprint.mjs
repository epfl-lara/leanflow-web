import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'

// Build artifacts are reusable inputs to Lake, never certificates for the
// current source. Include auxiliary inputs and symlink targets, excluding only
// Git metadata and Lake's generated state.
export async function sourceFingerprint(root) {
  const files = []
  async function walk(directory, relative = '') {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      if (['.lake', '.git'].includes(entry.name)) continue
      const filename = path.join(directory, entry.name)
      const name = path.posix.join(relative, entry.name)
      if (entry.isSymbolicLink())
        files.push([name, 'link', await fs.readlink(filename)])
      else if (entry.isDirectory()) await walk(filename, name)
      else if (entry.isFile()) {
        const file = await fs.open(
          filename,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        try {
          if (!(await file.stat()).isFile())
            throw new Error('Project input changed during checking.')
          const hash = createHash('sha256')
          for await (const chunk of file.createReadStream({ autoClose: false }))
            hash.update(chunk)
          files.push([name, hash.digest('hex')])
        } finally {
          await file.close()
        }
      }
    }
  }
  await walk(root)
  return createHash('sha256')
    .update(JSON.stringify(files.sort((a, b) => a[0].localeCompare(b[0]))))
    .digest('hex')
}
