import assert from 'node:assert/strict'
import test from 'node:test'
import { LeanProgress } from '../lean-progress.mjs'

const uri = 'file:///workspace/Main.lean'
const processing = (line) => ({
  method: '$/lean/fileProgress',
  params: {
    textDocument: { uri },
    processing: [
      {
        range: {
          start: { line, character: 0 },
          end: { line: line + 1, character: 0 },
        },
      },
    ],
  },
})
test('stationary Lean progress gets a neutral notice, then clears as processing advances', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const notices = []
  const progress = new LeanProgress((message) => notices.push(message))
  progress.client({
    method: 'textDocument/didOpen',
    params: {
      textDocument: {
        uri,
        text: 'import Mathlib\nexample : True := by trivial',
      },
    },
  })
  progress.server(processing(0))
  t.mock.timers.tick(60_000)
  assert.equal(notices.length, 1)
  assert.match(
    notices[0].params.message,
    /still processing line 1.*Large imports/,
  )
  assert.doesNotMatch(notices[0].params.message, /#eval|time limit/)
  progress.server(processing(1))
  assert.equal(notices.at(-1).params.message, '')
  progress.dispose()
})
test('the terminal hint appears only when progress is on an eval command and closing removes its timer', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const notices = []
  const progress = new LeanProgress((message) => notices.push(message))
  progress.client({
    method: 'textDocument/didOpen',
    params: { textDocument: { uri, text: '#eval chessMain []' } },
  })
  progress.server(processing(0))
  t.mock.timers.tick(60_000)
  assert.match(notices[0].params.message, /#eval.*keyboard.*terminal/)
  progress.client({
    method: 'textDocument/didClose',
    params: { textDocument: { uri } },
  })
  assert.equal(notices.at(-1).params.message, '')
  t.mock.timers.tick(60_000)
  assert.equal(notices.length, 2)
})
