import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const { outputText } = ts.transpileModule(
  fs.readFileSync(
    new URL('./definitionPreviewFiles.ts', import.meta.url),
    'utf8',
  ),
  {
    compilerOptions: {
      target: ts.ScriptTarget.ES2023,
      module: ts.ModuleKind.CommonJS,
    },
  },
)
function fixture(load, projectId = 'preview-project') {
  const module = { exports: {} },
    requests = []
  let released = false
  new Function('exports', 'module', 'require', outputText)(
    module.exports,
    module,
    (name) => {
      if (name === './api')
        return {
          api: (url, options) => {
            requests.push({ url, ...options })
            return load(url, options)
          },
        }
      if (name === '@codingame/monaco-vscode-files-service-override')
        return {
          EmptyFileSystemProvider: class {
            async writeFile() {
              throw new Error('No permissions')
            }
          },
          FilePermission: { Readonly: 1 },
          FileType: { File: 1 },
          FileSystemProviderErrorCode: { FileNotFound: 'FileNotFound' },
          FileSystemProviderError: {
            create: (message, code) =>
              Object.assign(new Error(message), { code }),
          },
          registerFileSystemOverlay: (priority) => {
            assert(priority < 0, 'Existing browser drafts take precedence')
            return {
              dispose() {
                released = true
              },
            }
          },
        }
      throw new Error('Unexpected import: ' + name)
    },
  )
  return {
    files: new module.exports.DefinitionPreviewFiles(projectId),
    requests,
    released: () => released,
  }
}
function uri(path, scheme = 'file') {
  return {
    scheme,
    path,
    authority: '',
    query: '',
    fragment: '',
    toString: () => `${scheme}://${path}`,
  }
}
const text = (bytes) => new TextDecoder().decode(bytes)

test('definition preview reads coalesce stat and content, use project authentication, and remain read only', async () => {
  const f = fixture(async () => ({ content: 'def α := 1\n' }), 'project id')
  const resource = uri('/workspace/Nested/File name.lean')
  const [stat, bytes] = await Promise.all([
    f.files.stat(resource),
    f.files.readFile(resource),
  ])
  assert.equal(f.requests.length, 1)
  assert.equal(
    f.requests[0].url,
    '/api/projects/project%20id/file?path=Nested%2FFile%20name.lean',
  )
  assert.equal(stat.size, Buffer.byteLength('def α := 1\n'))
  assert.equal(stat.permissions, undefined)
  assert.equal(text(bytes), 'def α := 1\n')
  await assert.rejects(
    f.files.writeFile(resource, new Uint8Array()),
    /No permissions/,
  )
  f.files.dispose()
  assert(f.released())
})

test('library previews use authenticated workspace reads or the checked toolchain-source endpoint', async () => {
  const f = fixture(async () => ({
    content: 'theorem libraryLemma : True := by trivial\n',
  }))
  for (const path of [
    '/workspace/.lake/packages/lib/Main.lean',
    '/opt/lean-toolchains/pinned/src/lean/Init.lean',
  ]) {
    const resource = uri(path)
    assert.equal((await f.files.stat(resource)).permissions, 1)
    assert.match(text(await f.files.readFile(resource)), /libraryLemma/)
    const request = f.requests.at(-1)
    if (path.startsWith('/workspace/')) {
      assert.equal(
        request.url,
        '/api/projects/preview-project/file?path=' +
          encodeURIComponent('.lake/packages/lib/Main.lean'),
      )
      assert.equal(request.method, undefined)
    } else {
      assert.equal(request.url, '/api/projects/preview-project/library-source')
      assert.equal(request.method, 'POST')
      assert.deepEqual(JSON.parse(request.body), {
        uri: resource.toString(),
        line: 1,
      })
    }
  }
  f.files.dispose()
})

test('dependency documentation and configuration resolve as read-only project files', async () => {
  const f = fixture(async () => ({ content: '# Library α\n' }))
  for (const path of [
    '.lake/packages/lib/README.md',
    '.lake/packages/lib/lakefile.toml',
  ]) {
    const resource = uri('/workspace/' + path)
    const [stat, bytes] = await Promise.all([
      f.files.stat(resource),
      f.files.readFile(resource),
    ])
    assert.equal(stat.permissions, 1)
    assert.equal(stat.size, Buffer.byteLength('# Library α\n'))
    assert.equal(text(bytes), '# Library α\n')
    assert.equal(
      f.requests.at(-1).url,
      '/api/projects/preview-project/file?path=' + encodeURIComponent(path),
    )
    assert.equal(f.requests.at(-1).method, undefined)
    await assert.rejects(
      f.files.writeFile(resource, new Uint8Array()),
      /No permissions/,
    )
  }
  assert.equal(f.requests.length, 2)
  for (const path of [
    '/workspace/.lake/packages/lib/.env',
    '/workspace/.lake/packages/lib/data.bin',
    '/workspace/README.md',
    '/opt/toolchain/README.md',
  ])
    await assert.rejects(f.files.readFile(uri(path)), { code: 'FileNotFound' })
  assert.equal(f.requests.length, 2)
  f.files.dispose()
})

test('disposing a project aborts pending previews and never returns old source into the next project', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const old = fixture(() => gate, 'old-project'),
    resource = uri('/workspace/Main.lean')
  const reading = old.files.readFile(resource)
  old.files.dispose()
  assert(old.released())
  assert(old.requests[0].signal.aborted)
  release({ content: 'private old source' })
  assert.equal(text(await reading), '')
  assert.equal(text(await old.files.readFile(resource)), '')
  assert.equal(old.requests.length, 1)
  const next = fixture(
    async () => ({ content: 'next project source' }),
    'next-project',
  )
  assert.equal(text(await next.files.readFile(resource)), 'next project source')
  assert(next.requests[0].url.startsWith('/api/projects/next-project/'))
  next.files.dispose()
})

test('unavailable previews resolve harmlessly and can be retried; non-source resources never reach the API', async () => {
  let unavailable = true
  const f = fixture(async () => {
    if (unavailable) throw new Error('Module is not installed')
    return { content: 'restored source' }
  })
  const resource = uri('/opt/lean-toolchains/pinned/src/lean/Init.lean')
  assert.equal(text(await f.files.readFile(resource)), '')
  unavailable = false
  assert.equal(text(await f.files.readFile(resource)), 'restored source')
  for (const resource of [
    uri('/workspace/.env'),
    uri('/workspace/Main.lean', 'https'),
  ])
    await assert.rejects(f.files.readFile(resource), { code: 'FileNotFound' })
  assert.equal(f.requests.length, 2)
  f.files.dispose()
})
