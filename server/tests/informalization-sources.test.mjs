import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  hasNamedInformalizationRequest,
  prepareInformalizationSources,
} from '../informalization.mjs'
import { Runtime } from '../runtime.mjs'

const file = 'Proofs.lean'
function entry(name, axioms = []) {
  return { path: file, name, type: 'True', startLine: 3, endLine: 3, axioms }
}
function mockInventory(
  entries,
  fields = {},
  environment = {
    LEAN_SYSROOT: '/opt/lean-toolchains/pinned',
    LEAN_PATH: '/workspace/.lake/build/lib/lean',
    LEAN_SRC_PATH: '/workspace',
  },
) {
  return {
    async run(root, args, options) {
      assert.equal(options.network, 'none')
      assert.equal(options.readOnlyWorkspace, true)
      if (args[0] === 'lake')
        return { code: 0, stdout: JSON.stringify(environment) }
      assert.equal(options.readOnlyHome, true)
      return {
        code: 0,
        stdout: JSON.stringify({
          entries,
          missing: 0,
          omitted: 0,
          failed: [],
          ...fields,
        }),
      }
    },
  }
}
const check = (runtime, options) =>
  prepareInformalizationSources(runtime, '/unused', {
    paths: [file],
    ...options,
  })

test('project lookup requires an explicit named theorem request and respects whole-file scope', async () => {
  for (const prompt of [
    'Write up theorem identity.',
    'Write up `identity`.',
    'Write up Review.identity.',
    'Explain lemma `Review.identity` as prose.',
  ]) {
    assert.equal(hasNamedInformalizationRequest(prompt), true, prompt)
    const report = await check(
      mockInventory([entry('Review.identity'), entry('A.other')]),
      { prompt },
    )
    assert.deepEqual(
      report.entries.map((e) => e.name),
      ['Review.identity'],
    )
  }
  for (const prompt of [
    undefined,
    'Write up the whole file, especially theorem identity.',
    'Write up this file including theorem identity.',
    'Translate all the theorems including `Review.identity`.',
    'Explain the theorem here.',
    'Write up `paper.v1.markdown`.',
  ]) {
    assert.equal(hasNamedInformalizationRequest(prompt), false, prompt)
  }
})

test('explicit theorem names select exact declarations while a whole-file request keeps them all', async () => {
  const runtime = mockInventory([
    entry('A.eq_one'),
    entry('A.eq_one_extra', ['sorryAx']),
    entry('B.other', ['Classical.choice']),
  ])
  for (const prompt of [
    'Informalize A.eq_one and other.',
    'Informalize eq_one and B.other.',
  ]) {
    const report = await check(runtime, { prompt })
    assert.deepEqual(
      report.entries.map((e) => e.name),
      ['A.eq_one', 'B.other'],
    )
    assert.equal(report.status, 'checked')
  }
  assert.equal(
    (await check(runtime, { prompt: 'Informalize Unknown.result.' })).status,
    'incomplete',
  )
  const all = await check(runtime, {
    prompt: 'Explain all the theorems including A.eq_one.',
  })
  assert.equal(all.status, 'incomplete')
  assert.equal(all.entries.length, 3)
  assert.equal(all.entries[1].status, 'incomplete')
})
test('filenames, citations and section names accompanying a theorem do not become requested declarations', async () => {
  const runtime = mockInventory([
    entry('Review.identity'),
    entry('Review.other'),
  ])
  const prompt =
    'Informalize Review.identity in papers/paper.v1.markdown, referencing `Citation.A` and section Intro.Results.'
  const report = await check(runtime, { prompt })
  assert.equal(report.status, 'checked')
  assert.deepEqual(
    report.entries.map((e) => e.name),
    ['Review.identity'],
  )
  assert.equal(
    (await check(runtime, { prompt: 'Translate theorem Missing.result.' }))
      .status,
    'incomplete',
  )
})

test('ambiguous, missing, failed and limited coverage stays visible for named sources', async () => {
  const runtime = mockInventory([entry('A.shared'), entry('B.shared')])
  assert.equal(
    (await check(runtime, { prompt: 'Informalize shared.' })).entries.length,
    0,
  )
  assert.equal(
    (await check(runtime, { prompt: 'Explain `unknown`.' })).status,
    'incomplete',
  )
  const partial = mockInventory([entry('A.ok')], {
    failed: ['Broken.lean'],
    missing: 1,
    omitted: 5,
  })
  const report = await check(partial, {
    paths: [file, 'Broken.lean'],
    prompt: 'Informalize A.ok.',
  })
  assert.deepEqual(
    report.entries.map((e) => e.name),
    ['A.ok'],
  )
  assert.equal(report.status, 'incomplete')
  assert.match(report.detail, /Broken\.lean/)
  assert.match(report.detail, /no source location/)
  assert.match(report.detail, /limit/)
})
test('document references require an exact unique qualified theorem for each supplied name', async () => {
  const runtime = mockInventory([
    entry('A.good'),
    entry('B.alsoGood'),
    entry('A.bad', ['sorryAx']),
  ])
  const checked = await check(runtime, {
    names: ['B.alsoGood'],
    prompt: 'Translate the whole file.',
  })
  assert.equal(checked.status, 'checked')
  assert.deepEqual(
    checked.entries.map((e) => e.name),
    ['B.alsoGood'],
  )
  const partial = await check(runtime, {
    names: ['A.good', 'alsoGood', 'No.such'],
  })
  assert.equal(partial.status, 'incomplete')
  assert.deepEqual(
    partial.entries.map((e) => e.name),
    ['A.good'],
  )
  assert.match(partial.detail, /No.such/)
})

test('a focused declaration disambiguates its source range, independently of the prompt', async () => {
  const runtime = mockInventory([entry('A.first'), entry('A.second')])
  const proofTarget = { path: file, startLine: 3, endLine: 3, name: 'A.second' }
  const report = await check(runtime, {
    proofTarget,
    prompt: 'Translate A.first.',
  })
  assert.deepEqual(
    report.entries.map((e) => e.name),
    ['A.second'],
  )
  assert.equal(
    (
      await check(runtime, {
        proofTarget: { ...proofTarget, name: 'A.missing' },
      })
    ).status,
    'incomplete',
  )
})
test('a timeout explains that focused checks rebuild the complete source and imports', async () => {
  const normal = mockInventory([])
  const limited = {
    run: (root, args, options) =>
      args[0] === 'lake'
        ? normal.run(root, args, options)
        : { code: 124, timedOut: true, stdout: '' },
  }
  const report = await check(limited, {})
  assert.equal(report.status, 'unavailable')
  assert.match(report.detail, /three-minute/)
  assert.match(report.detail, /local imports/)
})

test('unavailable toolchain and cancelled workers never produce a checked status', async () => {
  assert.equal((await check(mockInventory([], {}, {}))).status, 'unavailable')
  assert.equal((await check({}, { paths: [] })).status, 'unavailable')
  const controller = new AbortController()
  const runtime = {
    run() {
      controller.abort()
      return { code: 1, stdout: '' }
    },
  }
  await assert.rejects(check(runtime, { signal: controller.signal }), {
    name: 'AbortError',
  })
})

const toolchains = process.env.STUDIO_INFORMALIZATION_TEST_TOOLCHAINS
test(
  'pinned Lean extracts real declarations and replays proofs and local dependencies offline',
  { skip: !toolchains },
  async (t) => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'lemex-test-informalization-'),
    )
    t.after(() => fs.rm(root, { force: true, recursive: true }))
    const project = path.join(root, 'project')
    const runtime = new Runtime({
      dataDir: root,
      scope: 'helper',
      hostToolchainDir: toolchains,
      cpus: 1,
      memory: '2g',
    })
    const info = await runtime.init()
    assert.equal(info.ready, true, info.error)
    const pin = 'leanprover/lean4:v4.35.0'
    await runtime.prepareToolchain(pin)
    await fs.mkdir(project)
    const source = [
      'import Lean',
      'import Helper',
      'macro "lemma " n:ident " : " t:term " := " pr:term : command => `(theorem $n : $t := $pr)',
      'namespace Review',
      'section Family',
      'variable {α : Type} [Inhabited α]',
      '/- theorem wrong : False := by sorry -/',
      'theorem default_eq',
      '    (x : α) (h : x = default) : default = x := h.symm',
      'private theorem localT : True := by trivial',
      'lemma valid : True := by trivial',
      'theorem direct : False := by sorry',
      'theorem inherited : False := direct',
      'theorem fromHelper : False := assumed',
      'axiom premise : False',
      'theorem custom : False := premise',
      'end Family',
      'end Review',
      'structure Box where',
      '  value : Nat',
      'inductive Tree where',
      '  | leaf',
      '  | branch : Tree → Tree → Tree',
      'theorem Box.mk.user_spec : True := by trivial',
      '',
    ].join('\n')
    await Promise.all([
      fs.writeFile(path.join(project, 'lean-toolchain'), pin + '\n'),
      fs.writeFile(
        path.join(project, 'lakefile.toml'),
        'name = "review"\n[[lean_lib]]\nname = "Proofs"\n',
      ),
      fs.writeFile(
        path.join(project, 'Helper.lean'),
        'theorem assumed : False := by sorry\n',
      ),
      fs.writeFile(path.join(project, file), source),
      fs.writeFile(
        path.join(project, 'Unlocated.lean'),
        [
          'import Lean',
          'open Lean Elab Command in',
          'run_cmd liftCoreM <| addDecl <| .thmDecl { name := `User.injEq, levelParams := [], type := mkConst ``True, value := mkConst ``True.intro }',
          '',
        ].join('\n'),
      ),
      fs.writeFile(
        path.join(project, 'Broken.lean'),
        'theorem invalid : False := by trivial\n',
      ),
    ])
    assert.equal(
      (await runtime.run(project, ['lake', 'update'], { network: 'none' }))
        .code,
      0,
    )
    const run = (args) => prepareInformalizationSources(runtime, project, args)
    const report = await run({ paths: [file, 'Broken.lean', 'Unlocated.lean'] })
    assert.equal(report.status, 'incomplete', report.detail)
    assert.match(report.detail, /Broken\.lean/)
    assert.match(report.detail, /no source location for 1 theorem/)
    assert.deepEqual(
      report.entries.map((e) => e.name),
      [
        'Review.default_eq',
        'Review.localT',
        'Review.valid',
        'Review.direct',
        'Review.inherited',
        'Review.fromHelper',
        'Review.custom',
        'Box.mk.user_spec',
      ],
    )
    assert.deepEqual(
      [report.entries[0].startLine, report.entries[0].endLine],
      [8, 9],
    )
    assert.match(
      report.entries[0].type,
      /∀ \{α : Type\} \[inst : Inhabited α\]/,
    )
    assert.deepEqual(
      report.entries.map((e) => e.status),
      [
        'checked',
        'checked',
        'checked',
        'incomplete',
        'incomplete',
        'incomplete',
        'incomplete',
        'checked',
      ],
    )
    assert.deepEqual(report.entries[3].axioms, ['sorryAx'])
    assert.deepEqual(report.entries[5].axioms, ['sorryAx'])
    assert.deepEqual(report.entries[6].axioms, ['Review.premise'])
    const focused = await run({
      paths: [file],
      proofTarget: {
        path: file,
        startLine: 9,
        endLine: 9,
        name: 'Review.default_eq',
      },
    })
    assert.equal(focused.status, 'checked', focused.detail)
    assert.deepEqual(focused.entries, [report.entries[0]])
    assert.equal(await fs.readFile(path.join(project, file), 'utf8'), source)
  },
)
