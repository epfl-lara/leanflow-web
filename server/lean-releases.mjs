import { readFileSync, promises as fs } from 'node:fs'
import path from 'node:path'

const release = /^v4\.\d+\.\d+(?:-rc\d+)?$/
const stable = /^v4\.\d+\.\d+$/
const newer = (left, right) =>
  left
    .slice(1)
    .split('.')
    .map(Number)
    .reduce(
      (result, part, i) =>
        result || Math.sign(part - Number(right.slice(1).split('.')[i])),
      0,
    ) > 0

// Discover choices, then pin an exact version in every new project. Existing
// projects and library dependency graphs never follow a floating release tag.
export class LeanReleases {
  constructor(runtimeDir, fallback) {
    this.filename = path.join(runtimeDir, 'lean-releases.json')
    this.latest = fallback.replace('leanprover/lean4:', '')
    this.versions = [this.latest]
    try {
      const cached = JSON.parse(readFileSync(this.filename, 'utf8'))
      this.accept(cached)
    } catch {
      /* Offline first start uses the bundled stable version. */
    }
  }

  accept({ latest, versions }) {
    if (!stable.test(latest) || !Array.isArray(versions)) return
    if (newer(latest, this.latest)) this.latest = latest
    this.versions = [
      ...new Set([
        this.latest,
        ...versions.filter((v) => typeof v === 'string' && release.test(v)),
      ]),
    ].slice(0, 30)
  }

  async refresh(signal) {
    const fetchJson = async (suffix) => {
      const response = await fetch(
        `https://api.github.com/repos/leanprover/lean4/releases${suffix}`,
        {
          headers: {
            Accept: 'application/vnd.github+json',
            'User-Agent': 'LeanFlow-Web',
          },
          signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
            : AbortSignal.timeout(10_000),
        },
      )
      if (!response.ok)
        throw new Error(
          `Lean release discovery returned HTTP ${response.status}`,
        )
      const value = await response.text()
      if (value.length > 2_000_000)
        throw new Error('Lean release response is too large')
      return JSON.parse(value)
    }
    const [latest, releases] = await Promise.all([
      fetchJson('/latest'),
      fetchJson('?per_page=20'),
    ])
    if (!stable.test(latest.tag_name) || !Array.isArray(releases))
      throw new Error('Invalid Lean release catalog')
    this.accept({
      latest: latest.tag_name,
      versions: releases.filter((r) => !r.draft).map((r) => r.tag_name),
    })
    await fs.mkdir(path.dirname(this.filename), {
      recursive: true,
      mode: 0o700,
    })
    const temporary = `${this.filename}.${process.pid}.tmp`
    await fs.writeFile(
      temporary,
      JSON.stringify({ latest: this.latest, versions: this.versions }) + '\n',
      { mode: 0o600 },
    )
    await fs.rename(temporary, this.filename)
  }
}
