import path from 'node:path'
import { execFile } from 'node:child_process'

const workspace = '/workspace'
const tomlRequires = String.raw`
import json, sys, tomllib
try:
    config = tomllib.loads(sys.stdin.read())
except tomllib.TOMLDecodeError:
    print('[]')
else:
    requires = config.get('require', [])
    print(json.dumps([
        {'type': 'path', 'name': item.get('name'), 'dir': item['path']}
        for item in (requires if isinstance(requires, list) else [])
        if isinstance(item, dict) and 'path' in item
    ]))
`

function label(dependency) {
  return typeof dependency.name === 'string'
    ? `Local dependency ${dependency.name.replace(/[\p{Cc}]/gu, '').slice(0, 100)}`
    : 'A local dependency'
}

export function localDependencyDirectories(manifest) {
  const directories = new Set()
  for (const dependency of Array.isArray(manifest?.packages)
    ? manifest.packages
    : []) {
    if (dependency?.type !== 'path') continue
    if (typeof dependency.dir !== 'string' || dependency.dir.includes('\0'))
      throw Object.assign(
        new Error(
          `${label(dependency)} needs a valid project-relative folder path.`,
        ),
        { status: 400 },
      )
    const resolved = path.posix.resolve(workspace, dependency.dir)
    if (resolved !== workspace && !resolved.startsWith(workspace + '/'))
      throw Object.assign(
        new Error(
          `${label(dependency)} is outside the selected project folder. This selected-folder layout is not supported. Use a Lean workspace whose project root contains both packages, or place the dependency inside the selected folder. Original files and pinned versions are preserved; automatic setup repair cannot access the missing folder.`,
        ),
        { status: 409, unsupportedLayout: true },
      )
    directories.add(path.posix.relative(workspace, resolved) || '.')
  }
  return [...directories]
}

function readTomlDependencies(content) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'python3',
      ['-I', '-c', tomlRequires],
      {
        timeout: 5000,
        maxBuffer: 2 * 1024 * 1024,
      },
      (error, stdout) => {
        if (error) {
          reject(
            Object.assign(
              new Error(
                'Local dependency folders could not be checked. Ask the administrator to verify Python 3.11 or newer, then retry setup.',
              ),
              { status: 503, infrastructure: true },
            ),
          )
          return
        }
        try {
          resolve(JSON.parse(stdout))
        } catch {
          reject(
            new Error(
              'Local dependency folders could not be read from the project configuration.',
            ),
          )
        }
      },
    )
    child.stdin.on('error', () => {})
    child.stdin.end(content)
  })
}

export async function validateDependencyLayout(configuration) {
  let manifest
  try {
    manifest = JSON.parse(configuration['lake-manifest.json'])
  } catch {
    // Lake reports malformed manifests; this check only recognizes layouts.
  }
  localDependencyDirectories(manifest)
  // Lake's executable configuration takes precedence when both files exist.
  // Never evaluate it on the coordinator to discover project paths.
  if (
    typeof configuration['lakefile.toml'] === 'string' &&
    typeof configuration['lakefile.lean'] !== 'string'
  )
    localDependencyDirectories({
      packages: await readTomlDependencies(configuration['lakefile.toml']),
    })
}
