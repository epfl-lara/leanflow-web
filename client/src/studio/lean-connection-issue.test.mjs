import assert from 'node:assert/strict'
import test from 'node:test'
import { editorAdmissionReasons } from '../../../shared/editor-queue.mjs'
import {
  leanConnectionCloseMessage,
  leanConnectionFailed,
} from './leanConnectionIssue.ts'

test('editor close messages preserve admission, access, and project setup guidance', () => {
  for (const reason of Object.values(editorAdmissionReasons))
    assert.equal(leanConnectionCloseMessage(1013, reason.slice(0, 100)), reason)
  for (const [code, reason] of [
    [1008, 'Account access changed. Sign in again.'],
    [1012, 'Project configuration changed. Retry setup.'],
    [1013, 'This project is not ready for a Lean connection.'],
  ])
    assert.equal(leanConnectionCloseMessage(code, reason), reason)
})

test('unrecognized server details stay out of editor alerts and normal closes stay quiet', () => {
  const detail = 'cannot read /private/fixture/project'
  for (const code of [1001, 1006, 1008, 1009, 1011, 1012, 1013]) {
    const message = leanConnectionCloseMessage(code, detail)
    assert.ok(message)
    assert.ok(!message.includes(detail))
  }
  assert.equal(leanConnectionCloseMessage(1006, ''), leanConnectionFailed)
  assert.equal(leanConnectionCloseMessage(1000, ''), '')
})
