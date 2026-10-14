import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { LeanProjectIndex } from '../lean-project-index.mjs'

async function fixture(
  t,
  { source = 'Use.lean', output = '.lake/build/lib/lean/Use.ilean' } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lean-rename-index-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const write = async (name, content, time) => {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true })
    await fs.writeFile(path.join(root, name), content)
    if (time) await fs.utimes(path.join(root, name), time, time)
  }
  await write('Main.lean', 'def blank := 0\n', 100)
  await write(source, 'import Main\n#check blank\n', 100)
  await write(output, '{}', 200)
  await write(
    output.replace(/\.ilean$/, '.trace'),
    JSON.stringify({ inputs: [['/workspace/' + source, 'hash']] }),
    200,
  )
  const files = [
    { path: 'Main.lean' },
    { path: source },
    ...(output.startsWith('.lake/') ? [] : [{ path: output }]),
  ]
  const index = new LeanProjectIndex({ root, files: async () => files })
  return {
    root,
    source,
    output,
    write,
    index,
    files,
    open: new Set(['file:///workspace/Main.lean']),
  }
}

test('rename index refreshes compiled modules and only acknowledges notifications actually forwarded', async (t) => {
  const f = await fixture(t)
  const first = await f.index.capture(f.open)
  assert.equal(first.changes.length, 1)
  assert.equal((await f.index.capture(f.open)).changes.length, 1)
  first.commit()
  assert.equal((await f.index.capture(f.open)).changes.length, 0)
  await f.write(f.output, '{"updated":true}', 300)
  assert.equal((await f.index.capture(f.open)).changes.length, 1)
})

test('unbuilt, shifted, deleted and newly added unopened sources never use stale references', async (t) => {
  const f = await fixture(t)
  const snapshot = await f.index.capture(f.open)
  await f.write(f.source, '-- inserted line\nimport Main\n#check blank\n', 300)
  await assert.rejects(f.index.capture(f.open), /Use.lean.*Check Project/)
  await assert.rejects(snapshot.validate(), /changed during this rename/)
  await f.write(f.output, '{}', 400)
  await f.write(
    f.output.replace(/\.ilean$/, '.trace'),
    JSON.stringify({ inputs: [['/workspace/' + f.source, 'new hash']] }),
    400,
  )
  await f.index.capture(f.open)
  await f.write('New.lean', 'import Main\n#check blank', 100)
  f.files.push({ path: 'New.lean' })
  await assert.rejects(f.index.capture(f.open), /New.lean.*Check Project/)
})

test('custom source and build directories use Lake trace source mappings', async (t) => {
  const f = await fixture(t, {
    source: 'src/Use.lean',
    output: 'build/lean/Use.ilean',
  })
  const snapshot = await f.index.capture(f.open)
  assert.equal(
    snapshot.changes[0].uri,
    'file:///workspace/build/lean/Use.ilean',
  )
  await snapshot.validate()
})

test('older pinned Lake releases without trace input lists retain their standard module paths', async (t) => {
  const f = await fixture(t, {
    source: 'src/Use.lean',
    output: '.lake/build/lib/Use.ilean',
  })
  for (const trace of [
    JSON.stringify({ depHash: 123, log: [] }),
    '12345678901234567',
  ]) {
    await f.write(f.output.replace(/\.ilean$/, '.trace'), trace, 200)
    const snapshot = await f.index.capture(f.open)
    assert.equal(snapshot.changes.length, 1)
    await snapshot.validate()
  }
})

test('index guards reject linked sources and build directories without reading their targets', async (t) => {
  const f = await fixture(t)
  await fs.rename(
    path.join(f.root, 'Use.lean'),
    path.join(f.root, 'Saved.lean'),
  )
  await fs.symlink('Saved.lean', path.join(f.root, 'Use.lean'))
  await assert.rejects(f.index.capture(f.open), /project/)
  await fs.unlink(path.join(f.root, 'Use.lean'))
  await fs.rename(
    path.join(f.root, 'Saved.lean'),
    path.join(f.root, 'Use.lean'),
  )
  await fs.rename(
    path.join(f.root, '.lake/build'),
    path.join(f.root, 'OtherBuild'),
  )
  await fs.symlink('../OtherBuild', path.join(f.root, '.lake/build'))
  await assert.rejects(f.index.capture(f.open), /project/)
})
