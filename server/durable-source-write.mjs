import { constants } from 'node:fs'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const conflict = () =>
  Object.assign(
    new Error(
      'The file path changed during saving. Refresh the file before trying again.',
    ),
    { status: 409 },
  )

function syncError(cause, committed) {
  return Object.assign(
    new Error(
      committed
        ? 'The updated file is visible, but storage could not confirm a durable save. Keep or download your draft, then retry saving. A retry with the same text will not overwrite other edits.'
        : 'Storage could not confirm the save before the file was replaced. Your original file is unchanged. Keep or download your draft, then retry.',
      { cause },
    ),
    {
      status: 503,
      sourceCommitted: committed,
    },
  )
}

async function assertParent(parent, destination) {
  if ((await fs.realpath(parent.anchor)) !== path.dirname(destination))
    throw conflict()
}

async function sync(handle, committed) {
  try {
    await handle.sync()
  } catch (cause) {
    throw syncError(cause, committed)
  }
}

export async function durableSourceWrite({
  parent,
  destination,
  content,
  mode,
  unchanged,
  authorize,
}) {
  let temporary,
    staged,
    committed = false
  try {
    await assertParent(parent, destination)
    if (unchanged) {
      const filename = `${parent.anchor}/${parent.name}`
      const existing = await fs.open(
        filename,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      try {
        const before = await existing.stat()
        if (
          !before.isFile() ||
          (await fs.realpath(`/proc/self/fd/${existing.fd}`)) !== destination
        )
          throw conflict()
        await sync(existing, true)
        await authorize()
        const after = await fs.lstat(filename)
        if (
          after.isSymbolicLink() ||
          before.dev !== after.dev ||
          before.ino !== after.ino
        )
          throw conflict()
        await assertParent(parent, destination)
        await sync(parent.handle, true)
      } finally {
        await existing.close().catch(() => {})
      }
      return
    }
    temporary = `${parent.anchor}/.lemex-write-${randomUUID()}`
    staged = await fs.open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    )
    await staged.writeFile(content)
    await staged.chmod(mode)
    await sync(staged, false)
    await staged.close()
    staged = null
    await authorize()
    await assertParent(parent, destination)
    await fs.rename(temporary, `${parent.anchor}/${parent.name}`)
    committed = true
    await sync(parent.handle, true)
    await assertParent(parent, destination)
  } catch (cause) {
    if (committed && !cause.sourceCommitted) throw syncError(cause, true)
    if (!cause.status && !cause.statusCode && cause.code)
      throw syncError(cause, false)
    throw cause
  } finally {
    if (staged) await staged.close().catch(() => {})
    if (temporary) await fs.rm(temporary, { force: true }).catch(() => {})
  }
}
