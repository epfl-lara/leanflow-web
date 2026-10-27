import { constants } from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { readDependencyConfiguration } from './shared-dependencies.mjs'
import { PROJECT_CONFIGURATION_FILES } from '../shared/project-configuration.mjs'

export const leanConfigurationFiles = PROJECT_CONFIGURATION_FILES
export const leanBasicsLakefile =
  'name = "lean_workspace"\nversion = "0.1.0"\ndefaultTargets = ["Main"]\n\n[[lean_lib]]\nname = "Main"\n'

const fail = (message, status = 409) => {
  throw Object.assign(new Error(message), { status })
}

export async function hasLeanConfiguration(root) {
  for (const name of leanConfigurationFiles) {
    try {
      await fs.lstat(path.join(root, name))
      return true
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
  }
  return false
}

// Only add the selected environment's configuration. Repository sources,
// documents, existing Lean files, Git history and ignore rules remain intact.
export async function initializeLeanEnvironment(
  root,
  { template, toolchain, imports },
) {
  const directory = await fs.open(
    root,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  )
  const anchor = `/proc/self/fd/${directory.fd}`
  const created = []
  try {
    if ((await fs.realpath(anchor)) !== path.resolve(root))
      fail('The project directory changed. Refresh the project and try again.')
    if (await hasLeanConfiguration(anchor))
      fail(
        'Lean configuration already exists. Retry normal project setup to preserve its versions.',
      )
    const configuration = template
      ? readDependencyConfiguration(template)
      : {
          'lakefile.toml': leanBasicsLakefile,
        }
    configuration['lean-toolchain'] = toolchain + '\n'
    if (!configuration['lakefile.toml'] && !configuration['lakefile.lean'])
      fail('The selected library environment is not prepared.', 503)
    const additions = {
      ...configuration,
      'Main.lean':
        imports.map((name) => `import ${name}`).join('\n') +
        '\n\n-- Add your formalization here.\n',
      '.gitignore': '.lake/\n',
    }
    for (const [name, content] of Object.entries(additions)) {
      let file
      try {
        file = await fs.open(
          path.join(anchor, name),
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW,
          0o600,
        )
      } catch (error) {
        if (
          error.code === 'EEXIST' &&
          ['Main.lean', '.gitignore'].includes(name)
        )
          continue
        throw error
      }
      try {
        const stat = await file.stat()
        created.push({ name, dev: stat.dev, ino: stat.ino })
        await file.writeFile(content)
        await file.sync()
      } finally {
        await file.close()
      }
    }
    await directory.sync()
    return created.map((file) => file.name)
  } catch (error) {
    for (const file of created.reverse()) {
      const target = path.join(anchor, file.name)
      const stat = await fs.lstat(target).catch(() => null)
      if (stat?.dev === file.dev && stat.ino === file.ino)
        await fs.unlink(target)
    }
    throw error
  } finally {
    await directory.close()
  }
}
