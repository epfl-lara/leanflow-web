#!/usr/bin/env node
// Real compiler/editor checks in disposable runtimes; no provider configuration.
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { Runtime } from '../server/runtime.mjs'
import { dependencyBuildPlan } from '../server/dependency-targets.mjs'
import { runPinnedLake } from '../server/pinned-lake.mjs'
import { checkEditorImports } from '../server/editor-imports.mjs'
import {
  dependencyBuildCommand,
  projectBuildCommand,
} from '../server/project-libraries.mjs'
import { checkSetupEditor } from './lib/setup-readiness.mjs'

const { values } = parseArgs({
  options: { toolchain: { type: 'string', multiple: true } },
})
const toolchains = [...new Set(values.toolchain || [])]
if (
  !toolchains.length ||
  toolchains.some(
    (pin) => !/^leanprover\/lean4:v4\.\d+\.\d+(?:-rc\d+)?$/.test(pin),
  )
)
  throw new Error(
    'Pass each exact official Lean release with --toolchain leanprover/lean4:v4.19.0.',
  )
const output = path.resolve(
  process.env.LEAN_TEST_REPORT_DIR || '.runtime/setup-compatibility',
  randomUUID(),
)
await fs.mkdir(output, { recursive: true, mode: 0o700 })
const report = { passed: false, providerCalls: 0, checks: [] }
try {
  for (const [index, toolchain] of toolchains.entries()) {
    const dataDir = path.join(output, `data-${index}`)
    const runtime = new Runtime({
      dataDir,
      scope: 'helper',
      maxConcurrent: 1,
      cpus: 2,
      memory: '2g',
      memoryBudget: '2g',
      ...(process.env.LEAN_TEST_TOOLCHAIN_DIR
        ? { hostToolchainDir: process.env.LEAN_TEST_TOOLCHAIN_DIR }
        : {}),
    })
    const check = { toolchain, passed: false, cleaned: false, layouts: [] }
    report.checks.push(check)
    try {
      const initialized = await runtime.init()
      assert.equal(initialized.ready, true, initialized.error)
      await runtime.prepareToolchain(toolchain, {
        onOutput: (text) => process.stdout.write(text),
      })
      for (const format of ['toml', 'lean']) {
        const root = path.join(dataDir, 'project-' + format)
        const layout = { format, passed: false }
        check.layouts.push(layout)
        const files = {
          'lean-toolchain': toolchain + '\n',
          ...(format === 'toml'
            ? {
                'lakefile.toml':
                  'name = "layout_fixture"\nsrcDir = "proof sources"\ndefaultTargets = ["Core"]\n[[lean_lib]]\nname = "Core"\n[[require]]\nname = "local"\npath = "vendor/local"\n',
              }
            : {
                'lakefile.lean':
                  'import Lake\nopen Lake DSL\npackage layout_fixture where\n  srcDir := "proof sources"\nrequire «local» from "vendor/local"\n@[default_target] lean_lib Core\n',
              }),
          'proof sources/Core.lean': 'def coreReady : Nat := 3\n',
          'proof sources/Core/Extra.lean': 'def coreExtra : Nat := 4\n',
          'proof sources/Notes.lean':
            'import Core.Extra\nimport Local.Optional\nexample : coreExtra + localOptional = 11 := by\n  rfl\n',
          ...(format === 'toml'
            ? {
                'vendor/local/lakefile.toml':
                  'name = "local"\ndefaultTargets = ["Local"]\n[[lean_lib]]\nname = "Local"\n',
              }
            : {
                'vendor/local/lakefile.lean':
                  'import Lake\nopen Lake DSL\npackage «local»\n@[default_target] lean_lib Local\n',
              }),
          'vendor/local/Local.lean': 'def localReady : Nat := 2\n',
          'vendor/local/Local/Optional.lean': 'def localOptional : Nat := 7\n',
        }
        for (const [name, content] of Object.entries(files)) {
          await fs.mkdir(path.dirname(path.join(root, name)), {
            recursive: true,
          })
          await fs.writeFile(path.join(root, name), content)
        }
        const run = async (args, options = {}) => {
          const result = await runPinnedLake(runtime, root, args, {
            network: 'none',
            timeoutMs: 120000,
            cleanHome: true,
            ...options,
          })
          assert.equal(result.code, 0, result.stderr + '\n' + result.stdout)
        }
        await run(['lake', 'update'])
        const manifestFile = path.join(root, 'lake-manifest.json')
        const originalManifest = await fs.readFile(manifestFile, 'utf8')
        const imports = await runtime.projectImportRequirements(root)
        assert(
          imports.includes('Core.Extra') && imports.includes('Local.Optional'),
        )
        const plan = await dependencyBuildPlan(runtime, root, {
          includeRoot: true,
          requiredImports: imports,
        })
        assert(plan['@layout_fixture'].includes('@layout_fixture/+Core.Extra'))
        assert(plan['@local'].includes('@local/+Local.Optional'))
        await run(dependencyBuildCommand('@local', plan))
        await run(projectBuildCommand({ name: 'layout_fixture' }, plan))
        const readiness = await checkEditorImports(runtime, root)
        assert.equal(readiness.ready, true, readiness.message)
        await run(['lake', 'env', 'lean', 'proof sources/Notes.lean'], {
          readOnlyWorkspace: true,
          writeLakeCache: true,
        })
        layout.editor = await checkSetupEditor(
          runtime,
          root,
          'proof sources/Notes.lean',
          {
            line: 3,
            character: 2,
          },
        )
        for (const [name, content] of Object.entries(files))
          assert.equal(
            await fs.readFile(path.join(root, name), 'utf8'),
            content,
          )
        assert.equal(await fs.readFile(manifestFile, 'utf8'), originalManifest)
        layout.plan = plan
        layout.imports = readiness.message
        layout.passed = true
      }
      check.passed = true
    } catch (error) {
      check.error = error.message
      throw error
    } finally {
      await runtime.shutdown()
      await fs.rm(dataDir, { recursive: true, force: true })
      check.cleaned = true
    }
    console.log(JSON.stringify(check))
  }
  report.passed = true
} finally {
  await fs.writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(report, null, 2) + '\n',
  )
  console.log(
    JSON.stringify({
      report: path.join(output, 'result.json'),
      passed: report.passed,
    }),
  )
}
