import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import {
  browserStorageCompatibility,
  patchBrowserStorage,
} from '../../client/build/browser-storage-compat.mjs'

const entry = fileURLToPath(import.meta.resolve('lib0/storage'))
const source = await fs.readFile(entry, 'utf8')
const denied = () =>
  Object.assign(new Error('Storage is blocked.'), { name: 'SecurityError' })

function evaluate({ storage, getter } = {}) {
  const calls = []
  const context = {
    addEventListener: (...args) => calls.push(['add', ...args]),
    removeEventListener: (...args) => calls.push(['remove', ...args]),
  }
  Object.defineProperty(
    context,
    'localStorage',
    getter ? { get: getter } : { value: storage },
  )
  const patched = patchBrowserStorage(source)
  const exports = vm.runInNewContext(
    patched.replaceAll('export const ', 'const ') +
      '\n;({ varStorage, onChange, offChange })',
    context,
  )
  return { ...exports, calls }
}

test('lib0 storage operations and event listeners retain normal browser behavior', () => {
  const values = new Map()
  const native = {
    getItem(key) {
      assert.equal(this, native)
      return values.get(String(key)) ?? null
    },
    setItem(key, value) {
      assert.equal(this, native)
      values.set(String(key), String(value))
    },
  }
  const f = evaluate({ storage: native })
  assert.equal(f.varStorage.getItem('missing'), null)
  f.varStorage.setItem('preference', 42)
  assert.equal(f.varStorage.getItem('preference'), '42')
  assert.equal(values.get('preference'), '42')
  const listener = () => {}
  f.onChange(listener)
  f.offChange(listener)
  assert.deepEqual(f.calls, [
    ['add', 'storage', listener],
    ['remove', 'storage', listener],
  ])
})

test('a denied localStorage getter keeps the existing in-memory fallback', () => {
  const f = evaluate({
    getter: () => {
      throw denied()
    },
  })
  assert.equal(f.varStorage.getItem('production'), undefined)
  f.varStorage.setItem('draft', 'temporary')
  assert.equal(f.varStorage.getItem('draft'), 'temporary')
  f.onChange(() => {})
  f.offChange(() => {})
  assert.deepEqual(f.calls, [])
})

test('denied getItem cannot break startup reads and subsequent writes remain available in memory', () => {
  let nativeReads = 0
  const f = evaluate({
    storage: {
      getItem() {
        nativeReads++
        throw denied()
      },
      setItem() {
        assert.fail('The failed native store must be replaced for this module')
      },
    },
  })
  assert.equal(f.varStorage.getItem('production'), undefined)
  f.varStorage.setItem('broadcast', 'temporary')
  assert.equal(f.varStorage.getItem('broadcast'), 'temporary')
  assert.equal(nativeReads, 1)
})

test('denied setItem preserves the failed write and keeps listener cleanup paired', () => {
  let nativeWrites = 0
  const f = evaluate({
    storage: {
      getItem() {
        return null
      },
      setItem() {
        nativeWrites++
        throw denied()
      },
    },
  })
  const listener = () => {}
  f.onChange(listener)
  f.varStorage.setItem('broadcast', 'temporary')
  assert.equal(f.varStorage.getItem('broadcast'), 'temporary')
  f.varStorage.setItem('broadcast', 'updated')
  assert.equal(f.varStorage.getItem('broadcast'), 'updated')
  assert.equal(nativeWrites, 1)
  f.offChange(listener)
  assert.deepEqual(f.calls, [
    ['add', 'storage', listener],
    ['remove', 'storage', listener],
  ])
})

test('both build paths transform installed lib0 storage without changing its file', async () => {
  const compat = browserStorageCompatibility()
  assert.equal(
    await compat.vite.load(entry + '?v=fixture'),
    patchBrowserStorage(source),
  )
  let onLoad
  compat.esbuild.setup({
    onLoad: (_options, callback) => {
      onLoad = callback
    },
  })
  const result = await onLoad({ path: entry })
  assert.equal(result.loader, 'js')
  assert.equal(result.contents, patchBrowserStorage(source))
  assert.equal(await compat.vite.load(entry + '.unrelated'), undefined)
  assert.equal(await fs.readFile(entry, 'utf8'), source)
})

test('dependency shape changes fail clearly instead of dropping storage protection', () => {
  assert.throws(
    () => patchBrowserStorage('different upstream source'),
    /Browser storage compatibility changed/,
  )
  assert.throws(
    () => patchBrowserStorage(source + '\n' + source),
    /Browser storage compatibility changed/,
  )
  assert.throws(
    () =>
      patchBrowserStorage(
        source.replace(
          'let _localStorage = new VarStoragePolyfill()',
          'let _localStorage = localStorage',
        ),
      ),
    /Browser storage compatibility changed/,
  )
})
