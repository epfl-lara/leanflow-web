export function libraryModulePath(module) {
  if (
    typeof module !== 'string' ||
    module.length > 1000 ||
    !/^[\p{L}_][\p{L}\p{N}_']*(?:\.[\p{L}_][\p{L}\p{N}_']*)*$/u.test(module)
  )
    throw Object.assign(new Error('Choose a valid Lean module.'), {
      status: 400,
    })
  return `${module.replaceAll('.', '/')}.lean`
}

// Lean's installed sources use src/lean; its Git repository uses src.
// Preserve the provider's revision and line range, including for older indexes.
export function correctSourceUrl(value) {
  if (!value) return null
  const url = new URL(value)
  if (url.hostname === 'github.com')
    url.pathname = url.pathname.replace(
      /^(\/leanprover\/lean4\/blob\/[^/]+\/src\/)lean\/(?=(?:Init|Lean|Std)(?:\/|\.lean$))/,
      '$1',
    )
  return url.href
}

export function sourceSelection(content, signature) {
  if (!signature) return { line: null, endLine: null }
  const start = content.indexOf(signature)
  // Index and project versions can differ. Only jump to a unique local match.
  if (start < 0 || content.indexOf(signature, start + 1) >= 0)
    return { line: null, endLine: null }
  const line = content.slice(0, start).split('\n').length
  return { line, endLine: line + signature.split('\n').length - 1 }
}

export function toolchainSourceModule(toolchain, value) {
  const fail = () => {
    throw Object.assign(
      new Error(
        'This definition is outside the project’s installed Lean library.',
      ),
      { status: 400 },
    )
  }
  if (typeof value !== 'string' || value.length > 4000 || !toolchain) fail()
  let url, pathname
  try {
    url = new URL(value)
    pathname = decodeURIComponent(url.pathname)
  } catch {
    fail()
  }
  if (url.protocol !== 'file:' || url.host || url.search || url.hash) fail()
  const name = toolchain.replaceAll('/', '--').replaceAll(':', '---')
  const prefix = [
    `/opt/lean-toolchains/${name}/src/lean/`,
    `/home/worker/.elan/toolchains/${name}/src/lean/`,
  ].find((prefix) => pathname.startsWith(prefix))
  if (!prefix || !pathname.endsWith('.lean')) fail()
  const module = pathname.slice(prefix.length, -5).replaceAll('/', '.')
  libraryModulePath(module)
  if (!/^(?:Init|Lean|Std)(?:\.|$)/.test(module)) fail()
  return module
}
