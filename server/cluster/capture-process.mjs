import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)

// execFile can reject on cancellation before its child has stopped. Keep the
// capture lane and storage lease until helper cleanup and stdio have closed.
export async function captureProcess(...args) {
  const execution = execute(...args)
  const closed = execution.child
    ? new Promise((resolve) => execution.child.once('close', resolve))
    : Promise.resolve()
  try {
    return await execution
  } finally {
    await closed
  }
}
