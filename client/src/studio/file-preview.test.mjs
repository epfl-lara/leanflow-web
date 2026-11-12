import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import ts from 'typescript'

const restoredEvent = 'fixture:session-restored'
const settled = () => new Promise((resolve) => setImmediate(resolve))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function fixture(t) {
  const previous = {
    window: globalThis.window,
    createObjectURL: URL.createObjectURL,
    revokeObjectURL: URL.revokeObjectURL,
  }
  const listeners = new Set()
  class PreviewWindow extends EventTarget {
    addEventListener(name, listener, ...rest) {
      if (name === restoredEvent) listeners.add(listener)
      return super.addEventListener(name, listener, ...rest)
    }
    removeEventListener(name, listener, ...rest) {
      if (name === restoredEvent) listeners.delete(listener)
      return super.removeEventListener(name, listener, ...rest)
    }
  }
  globalThis.window = new PreviewWindow()
  const created = [],
    revoked = [],
    requests = []
  URL.createObjectURL = (blob) => {
    const url = `blob:fixture-preview-${created.length + 1}`
    created.push({ url, blob })
    return url
  }
  URL.revokeObjectURL = (url) => revoked.push(url)
  const states = [],
    effects = []
  let stateIndex = 0,
    effectIndex = 0
  const hooks = {
    useState(initial) {
      const index = stateIndex++
      if (!(index in states)) states[index] = initial
      return [
        states[index],
        (value) => {
          states[index] =
            typeof value === 'function' ? value(states[index]) : value
        },
      ]
    },
    useEffect(callback, dependencies) {
      const index = effectIndex++
      const effect = (effects[index] ??= {})
      if (
        effect.dependencies &&
        dependencies.every((value, i) =>
          Object.is(value, effect.dependencies[i]),
        )
      )
        return
      effect.pending = { callback, dependencies }
    },
  }
  const load = (kind) => (path, signal) => {
    const gate = deferred()
    requests.push({ kind, path, signal, ...gate })
    return gate.promise
  }
  const { outputText } = ts.transpileModule(
    fs.readFileSync(new URL('./useFilePreview.ts', import.meta.url), 'utf8'),
    {
      compilerOptions: {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.CommonJS,
      },
    },
  )
  const module = { exports: {} }
  new Function('module', 'exports', 'require', outputText)(
    module,
    module.exports,
    (name) => {
      if (name === 'react') return hooks
      assert.equal(name, './api')
      return {
        apiPdf: load('pdf'),
        apiImage: load('image'),
        apiHtml: load('html'),
        errorText: (error) => error.message,
        sessionBoundUrl: (path) => {
          const url = new URL(path, 'https://fixture.test')
          url.searchParams.set('expectedUserId', 'fixture-owner')
          return path.startsWith('/') ? url.pathname + url.search : url.href
        },
        SESSION_RESTORED_EVENT: restoredEvent,
      }
    },
  )
  let inputs = {
    path: '/preview?path=figure.png',
    kind: 'image',
    revision: 1,
    scope: 'first-project',
  }
  const render = (changes = {}) => {
    inputs = { ...inputs, ...changes }
    stateIndex = 0
    effectIndex = 0
    return module.exports.useFilePreview(
      inputs.path,
      inputs.kind,
      inputs.revision,
      inputs.scope,
    )
  }
  const commit = () => {
    for (const effect of effects) {
      if (!effect.pending) continue
      effect.cleanup?.()
      const pending = effect.pending
      effect.pending = null
      effect.dependencies = pending.dependencies
      effect.cleanup = pending.callback()
    }
  }
  const unmount = () => {
    for (const effect of effects) {
      effect.cleanup?.()
      effect.cleanup = undefined
      effect.pending = null
    }
  }
  t.after(() => {
    unmount()
    globalThis.window = previous.window
    URL.createObjectURL = previous.createObjectURL
    URL.revokeObjectURL = previous.revokeObjectURL
  })
  return { render, commit, unmount, requests, created, revoked, listeners }
}

test('PDF, image and HTML readers expose only their completed content and release blob resources', async (t) => {
  for (const kind of ['pdf', 'image', 'html'])
    await t.test(kind, async (t) => {
      const f = fixture(t)
      const initial = f.render({ kind })
      assert.equal(initial.content, undefined)
      assert.equal(initial.error, undefined)
      assert.equal(
        f.requests.length,
        0,
        'Rendering does not start a request before effects commit',
      )
      f.commit()
      assert.equal(f.requests[0].kind, kind)
      assert.equal(f.requests[0].path, '/preview?path=figure.png')
      const resource =
        kind === 'html'
          ? '<h1>Report</h1>'
          : new Blob([kind], {
              type: kind === 'pdf' ? 'application/pdf' : 'image/png',
            })
      f.requests[0].resolve(resource)
      await settled()
      const loaded = f.render()
      assert.equal(
        loaded.content,
        kind === 'html' ? resource : f.created[0].url,
      )
      assert.equal(loaded.error, undefined)
      assert.equal(f.created.length, kind === 'html' ? 0 : 1)
      if (kind !== 'html') assert.equal(f.created[0].blob, resource)
      f.unmount()
      assert.equal(f.requests[0].signal.aborted, true)
      assert.deepEqual(f.revoked, kind === 'html' ? [] : [loaded.content])
      assert.equal(f.listeners.size, 0)
    })
})

test('reusing a preview URL in a different project never shows the old project before effect cleanup', async (t) => {
  const f = fixture(t)
  f.render()
  f.commit()
  f.requests[0].resolve(new Blob(['PRIVATE_FIRST_PROJECT']))
  await settled()
  const old = f.render().content
  assert(old)
  const next = f.render({ scope: 'second-project' })
  assert.equal(next.content, undefined)
  assert.equal(next.error, undefined)
  assert.deepEqual(
    f.revoked,
    [],
    'The privacy check precedes the prior effect cleanup',
  )
  assert.equal(f.requests.length, 1)
  f.commit()
  assert.equal(f.requests[0].signal.aborted, true)
  assert.deepEqual(f.revoked, [old])
  f.requests[1].resolve(new Blob(['SECOND_PROJECT']))
  await settled()
  assert.notEqual(f.render().content, old)
  assert.equal(f.render().content, f.created[1].url)
})

test('delayed results and errors from aborted readers cannot replace the current preview', async (t) => {
  const f = fixture(t)
  f.render({ path: '/first-image', kind: 'image' })
  f.commit()
  f.render({ path: '/current-report', kind: 'html' })
  f.commit()
  assert.equal(f.requests[0].signal.aborted, true)
  f.requests[1].resolve('<p>Current report</p>')
  await settled()
  f.requests[0].resolve(new Blob(['late private image']))
  await settled()
  assert.equal(f.render().content, '<p>Current report</p>')
  assert.deepEqual(
    f.created,
    [],
    'An abandoned blob never acquires an object URL',
  )
  f.render({ path: '/failed-old-pdf', kind: 'pdf' })
  f.commit()
  f.render({ path: '/current-image', kind: 'image' })
  f.commit()
  f.requests[3].resolve(new Blob(['current image']))
  await settled()
  const current = f.render().content
  f.requests[2].reject(new Error('Late failure from a closed reader'))
  await settled()
  assert.equal(f.render().content, current)
  assert.equal(f.render().error, undefined)
})

test('reloads and source revisions retire each previous object URL exactly once', async (t) => {
  const f = fixture(t)
  f.render({ kind: 'pdf' })
  f.commit()
  f.requests[0].resolve(new Blob(['first PDF']))
  await settled()
  const first = f.render()
  first.retry()
  assert.equal(f.render().content, undefined)
  f.commit()
  assert.deepEqual(f.revoked, [first.content])
  f.requests[1].resolve(new Blob(['reloaded PDF']))
  await settled()
  const second = f.render().content
  assert.equal(f.render({ revision: 2 }).content, undefined)
  f.commit()
  assert.deepEqual(f.revoked, [first.content, second])
  f.requests[2].resolve(new Blob(['revised PDF']))
  await settled()
  const third = f.render().content
  f.unmount()
  f.unmount()
  assert.deepEqual(f.revoked, [first.content, second, third])
})

test('restoring the session retries a failed reader and removes the stale error before the next request commits', async (t) => {
  const f = fixture(t)
  f.render({ kind: 'html' })
  f.commit()
  f.requests[0].reject(new Error('Sign in again to open this document.'))
  await settled()
  assert.equal(f.render().error, 'Sign in again to open this document.')
  window.dispatchEvent(new Event(restoredEvent))
  const recovering = f.render()
  assert.equal(recovering.error, undefined)
  assert.equal(recovering.content, undefined)
  f.commit()
  assert.equal(f.requests.length, 2)
  assert.equal(f.requests[1].kind, 'html')
  f.requests[1].resolve('<p>Restored private report</p>')
  await settled()
  assert.equal(f.render().content, '<p>Restored private report</p>')
  assert.equal(f.render().error, undefined)
  f.unmount()
  assert.equal(f.listeners.size, 0)
})

test('SVG previews keep the authenticated sandboxed HTTP resource across reloads and never create a document blob URL', async (t) => {
  const f = fixture(t)
  const path =
    '/api/projects/first-project/file-preview?path=figures%2Fdiagram.svg&keep=original'
  const svg = new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], {
    type: 'image/svg+xml; charset=utf-8',
  })
  const protectedUrl = () => {
    const result = f.render()
    assert(result.content)
    assert(!result.content.startsWith('blob:'))
    const url = new URL(result.content, 'https://fixture.test')
    assert.equal(url.origin, 'https://fixture.test')
    assert.equal(url.pathname, '/api/projects/first-project/file-preview')
    assert.equal(url.searchParams.get('expectedUserId'), 'fixture-owner')
    assert.equal(url.searchParams.get('path'), 'figures/diagram.svg')
    assert.equal(url.searchParams.get('keep'), 'original')
    assert(url.searchParams.has('previewRevision'))
    return { result, url }
  }
  f.render({ path, kind: 'image' })
  f.commit()
  f.requests[0].resolve(svg)
  await settled()
  const first = protectedUrl()
  first.result.retry()
  assert.equal(f.render().content, undefined)
  f.commit()
  assert.equal(f.requests[0].signal.aborted, true)
  f.requests[1].resolve(svg)
  await settled()
  const second = protectedUrl()
  assert.notEqual(
    second.url.searchParams.get('previewRevision'),
    first.url.searchParams.get('previewRevision'),
  )
  assert.equal(f.render({ revision: 'edited-figure' }).content, undefined)
  f.commit()
  f.requests[2].resolve(svg)
  await settled()
  const third = protectedUrl()
  assert.notEqual(
    third.url.searchParams.get('previewRevision'),
    second.url.searchParams.get('previewRevision'),
  )
  f.unmount()
  assert.deepEqual(
    f.created,
    [],
    'SVG never obtains an app-origin blob document',
  )
  assert.deepEqual(f.revoked, [], 'No nonexistent SVG object URL is revoked')
})
