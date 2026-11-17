import { chmodSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'

// The server and account administration commands share users.json. SQLite's
// OS-backed writer lock is released on process exit, including after a crash.
export async function withAccountWriteLock(directory, change) {
  const filename = path.join(directory, 'users-write.lock')
  const lock = new DatabaseSync(filename)
  try {
    chmodSync(filename, 0o600)
    lock.exec('PRAGMA busy_timeout=0')
    const deadline = performance.now() + 10_000
    for (;;) {
      try {
        lock.exec('BEGIN IMMEDIATE')
        break
      } catch (error) {
        if (error.errcode !== 5 && error.errcode !== 6) throw error
        if (performance.now() >= deadline)
          throw Object.assign(
            new Error(
              'Another account change is taking longer than expected. Try again.',
            ),
            { status: 503 },
          )
        await delay(15 + Math.random() * 25)
      }
    }
    return await change()
  } finally {
    lock.close()
  }
}
