const categories = [
  {
    name: 'authentication',
    pattern:
      /\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid[_ -]?(?:api[_ -]?)?key|authentication (?:failed|error)|invalid[_ -]?(?:access[_ -]?)?token/i,
    message:
      'Lemex could not authenticate with the provider. Check your API key and provider access in Assistant settings.\n',
  },
  {
    name: 'rate',
    pattern: /rate[_ -]?limit|too many requests|\b429\b/i,
    message: 'The provider is limiting requests. Wait a moment and retry.\n',
  },
  {
    name: 'connection',
    pattern:
      /ECONN(?:REFUSED|RESET)|ENOTFOUND|EAI_AGAIN|timed out|timeout|\bTLS\b|certificate|error sending request|connection (?:failed|closed|reset|refused)/i,
    message:
      'Lemex could not connect to the provider or a configured tool. Check the provider address and try again.\n',
  },
  {
    name: 'model',
    pattern:
      /model[^\r\n]{0,160}(?:not found|not available|unsupported|invalid)|(?:unknown|unsupported|invalid)[^\r\n]{0,160}model/i,
    message:
      'The provider did not accept the selected model. Refresh models in Assistant settings and choose an available model.\n',
  },
  {
    name: 'tool',
    pattern:
      /mcp[^\r\n]{0,100}(?:failed|error|could not|couldn't)|(?:failed|could not)[^\r\n]{0,100}(?:tool|mcp)/i,
    message:
      'A Lemex tool could not start. Check the tool settings and retry.\n',
  },
]

// Native stderr may contain credentials, provider bodies, or partial secrets.
// Publish only fixed categories, never raw diagnostics or excerpts. A small
// overlap recognizes categories split across chunks; each category logs once.
export function createNativeDiagnosticHandler(onDiagnostic) {
  const seen = new Set()
  let tail = ''
  const publish = (name, message) => {
    if (seen.has(name)) return
    seen.add(name)
    onDiagnostic(message)
  }
  return (chunk) => {
    if (seen.size === categories.length + 1) return
    const incoming = String(chunk)
    for (let offset = 0; offset < incoming.length; offset += 8192) {
      const text = tail + incoming.slice(offset, offset + 8192)
      let classified = false
      for (const { name, pattern, message } of categories)
        if (pattern.test(text)) {
          classified = true
          publish(name, message)
        }
      if (!classified && /\b(?:error|failed|failure)\b/i.test(text))
        publish(
          'internal',
          'Lemex reported an internal diagnostic. If the run fails, retry or review its final error.\n',
        )
      tail = text.slice(-256)
    }
  }
}
