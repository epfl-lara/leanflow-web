import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const creation = 'this.languageClient = new MonacoLanguageClient(mlcConfig);'
const guardedCreation = `${creation}
        const guardedClient = this.languageClient;
        const stopClient = guardedClient.stop.bind(guardedClient);
        let transportClosed = false;
        guardedClient.stop = async (...args) => {
            if (transportClosed && !guardedClient.isRunning()) return;
            try { return await stopClient(...args); }
            catch (error) {
                const message = error instanceof Error ? error.message : '';
                if (transportClosed && /^(?:Stopping the server timed out|Pending response rejected since connection got disposed|Connection got disposed|Client is not running and can't be stopped\\.)/.test(message)) return;
                throw error;
            }
        };`

const expected = `this.messageTransports?.reader.onClose(async () => {
            await this.languageClient?.stop();`
const replacement = `this.messageTransports?.reader.onClose(async () => {
            transportClosed = true;
            // Transport closure already cancels initialization and cleans the
            // language client. Sending shutdown here cannot receive a reply.`

// Compatibility for lean4monaco 1.1.16 / monaco-editor-wrapper 5.5.3. Its
// reader-close listener sends shutdown over an already closed channel, which
// rejects unhandled during revocation/initialization. Remove this transform
// when the upstream listener stops doing that. Never modify installed modules:
// production checkouts can share their dependency directory.
export function patchLeanClientWrapper(source) {
  if (
    source.split(expected).length !== 2 ||
    source.split(creation).length !== 2
  )
    throw new Error(
      'Lean editor compatibility changed. Review the pinned monaco-editor-wrapper reader-close listener before updating dependencies.',
    )
  return source
    .replace(creation, guardedCreation)
    .replace(expected, replacement)
}

const startResult =
  '        return this._onStart;\n    }\n    createOnStartPromise()'
export function patchLanguageClientStartup(source) {
  if (source.split(startResult).length !== 2)
    throw new Error(
      'Lean client compatibility changed. Review the initialization promise after channel closure before updating dependencies.',
    )
  // vscode-languageclient 9.0.1 clears _onStart when the channel closes while
  // start() is awaiting initialize(). Returning that cleared field abandons the
  // rejected startup promise. Keep returning the exact local promise instead.
  // Remove this transform after upstream retains its initialization result.
  return source.replace(
    startResult,
    '        return promise;\n    }\n    createOnStartPromise()',
  )
}

export function leanClientCompatibility() {
  const entry = fileURLToPath(import.meta.resolve('monaco-editor-wrapper'))
  const leanEntry = fileURLToPath(import.meta.resolve('lean4monaco'))
  const languageRoot = path.dirname(
    fileURLToPath(import.meta.resolve('vscode-languageclient/package.json')),
  )
  const transforms = new Map([
    [
      path.join(path.dirname(entry), 'languageClientWrapper.js'),
      patchLeanClientWrapper,
    ],
    [
      path.join(languageRoot, 'lib/common/client.js'),
      patchLanguageClientStartup,
    ],
  ])
  const read = async (filename, transform) => {
    const manifest = JSON.parse(
      await fs.readFile(
        path.join(path.dirname(entry), '../package.json'),
        'utf8',
      ),
    )
    const leanManifest = JSON.parse(
      await fs.readFile(
        path.join(path.dirname(leanEntry), '../package.json'),
        'utf8',
      ),
    )
    const languageManifest = JSON.parse(
      await fs.readFile(path.join(languageRoot, 'package.json'), 'utf8'),
    )
    if (
      manifest.version !== '5.5.3' ||
      leanManifest.version !== '1.1.16' ||
      languageManifest.version !== '9.0.1'
    )
      throw new Error(
        'Lean editor compatibility requires lean4monaco 1.1.16, monaco-editor-wrapper 5.5.3 and vscode-languageclient 9.0.1. Review channel-closure cancellation before changing these versions.',
      )
    return transform(await fs.readFile(filename, 'utf8'))
  }
  return {
    vite: {
      name: 'lean-language-client-close-compatibility',
      enforce: 'pre',
      async load(id) {
        const filename = id.split('?')[0]
        const transform = transforms.get(filename)
        if (transform) return read(filename, transform)
      },
    },
    esbuild: {
      name: 'lean-language-client-close-compatibility',
      setup(build) {
        build.onLoad(
          {
            filter:
              /(?:[/\\]monaco-editor-wrapper[/\\]dist[/\\]languageClientWrapper\.js|[/\\]vscode-languageclient[/\\]lib[/\\]common[/\\]client\.js)$/,
          },
          async ({ path: filename }) => {
            const transform = transforms.get(filename)
            if (transform)
              return { contents: await read(filename, transform), loader: 'js' }
          },
        )
      },
    },
  }
}
