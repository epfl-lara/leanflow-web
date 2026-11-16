import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const initialStorage =
  'let _localStorage = new VarStoragePolyfill()\nlet usePolyfill = true'
const nativeStorage =
  '    _localStorage = localStorage\n    usePolyfill = false'
const guardedStorage = `    const memoryStorage = _localStorage
    let currentStorage = localStorage
    _localStorage = {
      getItem (key) {
        try { return currentStorage.getItem(key) }
        catch (_) {
          currentStorage = memoryStorage
          return currentStorage.getItem(key)
        }
      },
      setItem (key, value) {
        try { currentStorage.setItem(key, value) }
        catch (_) {
          currentStorage = memoryStorage
          currentStorage.setItem(key, value)
        }
      }
    }
    usePolyfill = false`

// lib0 0.2.117 guards access to localStorage but not the operations themselves.
// Browser policy can allow the getter while getItem/setItem still throw, breaking
// environment.js during application startup. Reuse lib0's existing memory store
// after an operation fails. Leave storage-event registration and removal paired.
// Remove this transform when upstream guards operational storage failures.
export function patchBrowserStorage(source) {
  if (
    source.split(initialStorage).length !== 2 ||
    source.split(nativeStorage).length !== 2
  )
    throw new Error(
      'Browser storage compatibility changed. Review the pinned lib0 storage fallback before updating dependencies.',
    )
  return source.replace(nativeStorage, guardedStorage)
}

export function browserStorageCompatibility() {
  const entry = fileURLToPath(import.meta.resolve('lib0/storage'))
  const manifest = fileURLToPath(import.meta.resolve('lib0/package.json'))
  const read = async () => {
    const installed = JSON.parse(await fs.readFile(manifest, 'utf8'))
    if (installed.version !== '0.2.117')
      throw new Error(
        'Browser storage compatibility requires lib0 0.2.117. Review operational storage failures before changing this version.',
      )
    return patchBrowserStorage(await fs.readFile(entry, 'utf8'))
  }
  return {
    vite: {
      name: 'browser-storage-compatibility',
      enforce: 'pre',
      async load(id) {
        if (path.normalize(id.split('?')[0]) === entry) return read()
      },
    },
    esbuild: {
      name: 'browser-storage-compatibility',
      setup(build) {
        build.onLoad(
          { filter: /[/\\]lib0[/\\]storage\.js$/ },
          async ({ path: filename }) => {
            if (path.normalize(filename) === entry)
              return { contents: await read(), loader: 'js' }
          },
        )
      },
    },
  }
}
