import assert from 'node:assert/strict'
import test from 'node:test'
import { editorAdmissionReasons } from '../../../shared/editor-queue.mjs'
import {
  leanConnectionCloseMessage,
  leanConnectionFailed,
  transientLeanStartupClose,
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

test('startup retries are reserved for transient transport or worker errors', () => {
  for (const code of [1006, 1011, 1012, 1013])
    assert.equal(transientLeanStartupClose(code, ''), true)
  for (const code of [1000, 1001, 1008, 1009])
    assert.equal(transientLeanStartupClose(code, ''), false)
  for (const reason of [
    editorAdmissionReasons.expired,
    editorAdmissionReasons.queueFull,
    editorAdmissionReasons.accountQueueFull,
    'Account access changed. Sign in again.',
    'This project is not ready for a Lean connection.',
  ])
    assert.equal(transientLeanStartupClose(1013, reason.slice(0, 100)), false)
  assert.equal(
    transientLeanStartupClose(
      1012,
      'Project configuration changed. Retry setup.',
    ),
    false,
  )
  assert.equal(
    transientLeanStartupClose(1013, editorAdmissionReasons.closing),
    true,
  )
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
