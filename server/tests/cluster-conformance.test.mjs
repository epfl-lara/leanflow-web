import test from 'node:test'
import assert from 'node:assert/strict'
import { kernelIsolationEvidence } from '../cluster/conformance.mjs'

test('native isolation evidence survives Lean JSON diagnostics and plain kernel-check progress', () => {
  const evidence = {
    label: 'leanflow-kernel-check (enforce)',
    network: 'none',
    capabilities: 0,
    scratch: 'bounded-tmpfs',
  }
  const marker = 'LEANFLOW_KERNEL_ISOLATION ' + JSON.stringify(evidence)
  const diagnostic = JSON.stringify({
    severity: 'information',
    data: marker + '\n',
    pos: { line: 1, column: 0 },
  })
  assert.deepEqual(
    kernelIsolationEvidence('Checking exports\n' + diagnostic + '\n'),
    evidence,
  )
  assert.deepEqual(kernelIsolationEvidence(marker + '\n'), evidence)
  assert.equal(
    kernelIsolationEvidence(
      'LEANFLOW_KERNEL_ISOLATION {\\"label\\":\\"invalid\\"}',
    ),
    null,
  )
  assert.equal(kernelIsolationEvidence('kernel check failed\n'), null)
})
