import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { readPresetConfiguration } from './prepared-presets.mjs'

const presets = JSON.parse(
  fs.readFileSync(new URL('./presets.json', import.meta.url), 'utf8'),
)
const roots = new Map()

export function publicPreset(id) {
  return presets.find((preset) => preset.id === id) || null
}

export function presetTemplatePaths(runtimeDir, preset) {
  const key = createHash('sha256')
    .update(JSON.stringify(preset))
    .digest('hex')
    .slice(0, 20)
  return [
    path.join(runtimeDir, 'templates', `${preset.id}-${key}`),
    path.join(runtimeDir, 'templates', preset.id),
  ]
}

export function publicPresetDefinition(dataDir, root) {
  if (!roots.has(dataDir)) {
    if (roots.size >= 128) roots.clear()
    roots.set(
      dataDir,
      new Map(
        presets.flatMap((preset) =>
          presetTemplatePaths(path.join(dataDir, 'runtime'), preset).map(
            (filename) => [filename, preset],
          ),
        ),
      ),
    )
  }
  return roots.get(dataDir).get(root) || null
}

export function verifiedPublicPreset(
  root,
  preset,
  { protectedMetadata = true } = {},
) {
  try {
    const directory = fs.lstatSync(root)
    if (
      !directory.isDirectory() ||
      directory.isSymbolicLink() ||
      (protectedMetadata &&
        (directory.uid !== process.getuid() || directory.mode & 0o022)) ||
      fs.realpathSync(root) !== root
    )
      return false
    const marker = path.join(root, '.ready.json')
    const stat = fs.lstatSync(marker)
    if (
      !stat.isFile() ||
      (protectedMetadata &&
        (stat.nlink !== 1 ||
          stat.uid !== process.getuid() ||
          stat.mode & 0o022)) ||
      stat.size > 64 * 1024
    )
      return false
    const metadata = JSON.parse(fs.readFileSync(marker, 'utf8'))
    if (
      metadata.code !== 0 ||
      metadata.toolchain !== preset.toolchain ||
      (preset.revision && metadata.revision !== preset.revision)
    )
      return false
    readPresetConfiguration(root, preset)
    return true
  } catch {
    return false
  }
}
