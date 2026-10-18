import assert from 'node:assert/strict'
import { webcrypto } from 'node:crypto'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const { outputText } = ts.transpileModule(
  readFileSync(new URL('./messageId.ts', import.meta.url), 'utf8'),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
  },
)
const module = { exports: {} }
new Function('exports', 'module', outputText)(module.exports, module)
const { messageId } = module.exports
const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

test('uses the native randomUUID method when it is available', () => {
  const expected = '1e734a11-e3e5-41ac-b014-91adce977bc4'
  const random = {
    randomUUID() {
      assert.equal(this, random)
      return expected
    },
    getRandomValues() {
      assert.fail('The native UUID method should handle this request')
    },
  }
  assert.equal(messageId(random), expected)
})

test('creates distinct UUIDs when HTTP does not expose randomUUID', () => {
  const random = { getRandomValues: webcrypto.getRandomValues.bind(webcrypto) }
  const values = Array.from({ length: 64 }, () => messageId(random))
  for (const value of values) assert.match(value, uuid)
  assert.equal(new Set(values).size, values.length)
})

test('fallback UUIDs preserve RFC 4122 version and variant for extreme random bytes', () => {
  for (const value of [0, 255]) {
    const id = messageId({ getRandomValues: (bytes) => bytes.fill(value) })
    assert.match(id, uuid)
  }
})
