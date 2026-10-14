import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
export const repository = 'https://github.com/openai/ten-proofs.git'
export const revision = '94bc0feb6a9ff12c7d31d6de640a725c9d43d2b6'
export const toolchain = 'leanprover/lean4:v4.32.0'
export const modules = [
  'SpherePacking',
  'MetricCodes',
  'NonSoficGroup',
  'ConnesRigidity',
  'Permanent',
  'QuantumParallelRepetition',
  'GapCVP',
  'EhrhartVolumeInequality',
  'MulticolorTriangleRamsey',
  'CompactnessAndDegeneracy',
]

// SHA-256 values of Git blobs at the public revision above, including all 43 tracked files.
export const expectedFiles = {
  '.gitignore': {
    sha256: '5b94714c0cf4121ffd0b05af22464b7289d334f8a9a96f6598fdb63b0a73b37c',
    bytes: 17,
  },
  'All.lean': {
    sha256: '27dacf454d00fbceb7cd0774d0266119c5f962d942b898e22e11ae34c854395a',
    bytes: 242,
  },
  'CompactnessAndDegeneracy.lean': {
    sha256: '17637d0697b9657f221dc1aa734cb1d19765b50edbfdda1dc3446874735fbd81',
    bytes: 721769,
  },
  'ComparatorChallenges/A_SpherePacking.json': {
    sha256: 'f952d88af50b26cb738b9b6d508929e5f20066db14d3394e71a6de1def8ea424',
    bytes: 467,
  },
  'ComparatorChallenges/A_SpherePacking.lean': {
    sha256: '2fca339f1c579d1f1a84ccfa9ce18744dfc51738ac6566b34b42f4f156a03353',
    bytes: 5883,
  },
  'ComparatorChallenges/B_BinaryCodes.json': {
    sha256: 'b100ddca78898d7df24225bef99c54be286ad5251cbd0806e584b7646a3700b2',
    bytes: 556,
  },
  'ComparatorChallenges/B_BinaryCodes.lean': {
    sha256: '60f102e9a07a1e3f425574cad460b011023c39dd2282c3ddb0c44387a067e480',
    bytes: 5805,
  },
  'ComparatorChallenges/B_SphericalCodes.json': {
    sha256: '204dfdd422e58ea761563f32043b6c778d56d5a4872817720e9f46a15215429f',
    bytes: 504,
  },
  'ComparatorChallenges/B_SphericalCodes.lean': {
    sha256: 'ae3069d60af00ecea40d0641cf6406318c412476f949d616ff7d488a6b8b1d87',
    bytes: 9409,
  },
  'ComparatorChallenges/C_PermanentFormulaLowerBound.json': {
    sha256: 'f80482f4a163041e036e26bb687690559cc36504e347b0ea3df0d626cfb965bb',
    bytes: 421,
  },
  'ComparatorChallenges/C_PermanentFormulaLowerBound.lean': {
    sha256: 'fc97578bcbb072ff82383e4c903107130ba3dd1a2209235ab32270c7df37f83d',
    bytes: 3605,
  },
  'ComparatorChallenges/D_NonSoficGroup.json': {
    sha256: '08c8e3666435ebfd1a946643f51221780f433224748debef6264e15953a66459',
    bytes: 328,
  },
  'ComparatorChallenges/D_NonSoficGroup.lean': {
    sha256: '346774c20eea754cf9bb2aaeffda8facae5aad74109bb70699e416f9da9c4adf',
    bytes: 1117,
  },
  'ComparatorChallenges/E_ConnesRigidity.json': {
    sha256: 'ca2bdd2752cc9839a63d8d5217408c1ae934eb0c93dc241580a18bf16fd36f6c',
    bytes: 434,
  },
  'ComparatorChallenges/E_ConnesRigidity.lean': {
    sha256: 'e03bbc49c0576b35dee3dcd527853567abe49ac2522fdb0c450b6a1aa0ec0a90',
    bytes: 7483,
  },
  'ComparatorChallenges/F_EhrhartVolumeInequality.json': {
    sha256: '60ff36064f6596a014005b91b13908db4673334e07b3a9117755684671de7d53',
    bytes: 488,
  },
  'ComparatorChallenges/F_EhrhartVolumeInequality.lean': {
    sha256: '15e900689c6550ed4b1bcae42bd1a7a78fc88071c4f70161574cff7c038d38c7',
    bytes: 2127,
  },
  'ComparatorChallenges/G_QuantumParallelRepetition.json': {
    sha256: '0a6577bcd92f582766321fd2cc974afb849e5be10463867c50ed11bd09b75a39',
    bytes: 393,
  },
  'ComparatorChallenges/G_QuantumParallelRepetition.lean': {
    sha256: '82c57a896253a5e393ec33a65d10771f13a80896664d7b1f208866a49b4e3e1b',
    bytes: 4660,
  },
  'ComparatorChallenges/H_GapCVP.json': {
    sha256: '08208d08d267bf25928b3cc630520eea79362b778bd5e2b6989b1547263168e9',
    bytes: 654,
  },
  'ComparatorChallenges/H_GapCVP.lean': {
    sha256: '2e8f30f3a6f9b827f912747387e8c8d25868123fa3cc2334da283c6e9bfd5352',
    bytes: 10839,
  },
  'ComparatorChallenges/I_MulticolorTriangleRamsey.json': {
    sha256: '03c4a87dfda6588dc685afbd4c6da4338f652166b24df0c4ff2f819ca22f5fd7',
    bytes: 562,
  },
  'ComparatorChallenges/I_MulticolorTriangleRamsey.lean': {
    sha256: '12f969e50e5b09579849e25692c8cfc1d9351d09278ec9c5e4ea7c36756a6273',
    bytes: 1624,
  },
  'ComparatorChallenges/J_CompactnessConjecture.json': {
    sha256: 'e9a7a93409f01b4ca611ddb21a6c69821f9fde60dd385651aa62f4ebe68ba3a6',
    bytes: 427,
  },
  'ComparatorChallenges/J_CompactnessConjecture.lean': {
    sha256: '0640640051c055e453df5551696ebaa61f3fa9d647ba9ec38b1734d280898801',
    bytes: 2862,
  },
  'ComparatorChallenges/J_TwoDegenerateGraphs.json': {
    sha256: '48e77981fb8a5f29e444f619cabb98d7c5df95d7150fb8808a17d94b05b38426',
    bytes: 359,
  },
  'ComparatorChallenges/J_TwoDegenerateGraphs.lean': {
    sha256: '9565db54e089c8a3d5be1d463c06429283aee131f0506306bb4bfaf64dfbdf9e',
    bytes: 1487,
  },
  'ComparatorChallenges/README.md': {
    sha256: 'dcf5e36bf69cb5f4dbf1db9c0c9770e437d791b88e426cb46a3177ef5a224584',
    bytes: 370,
  },
  'ConnesRigidity.lean': {
    sha256: '31f6c419f341ee6aa5b03bc15800a9d8ee2c654c344aab90bdef0639353ccc91',
    bytes: 1449151,
  },
  'EhrhartVolumeInequality.lean': {
    sha256: 'e16493429e7afaa3d12daf568ec23eddeaf02afeca414992c066f55f3251a4a5',
    bytes: 2163484,
  },
  'GapCVP.lean': {
    sha256: '625d84181085b04f9214bab855880d96c0657414509976cf47fb4e5ef1cc541a',
    bytes: 5335203,
  },
  LICENSE: {
    sha256: 'c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4',
    bytes: 11357,
  },
  'MetricCodes.lean': {
    sha256: 'f8b2b1b59f094005f37f34a746f30a2aa3afb6341d63151ee4f602758731eb32',
    bytes: 4531268,
  },
  'MulticolorTriangleRamsey.lean': {
    sha256: 'a87bd60efe16dab00ba07ea4069f22b8dbc991b3f3ba34ae5088b1f8b1987cd3',
    bytes: 125769,
  },
  'NonSoficGroup.lean': {
    sha256: 'f39b61646df1206d0b592f57c77c47cc41aea4761e12d99141bdae4776095534',
    bytes: 1343031,
  },
  'Permanent.lean': {
    sha256: 'bdd53fe0b026c9b9e369db67b3c040e5d3eeffd04d13f00e041d23eb33603111',
    bytes: 1131535,
  },
  'QuantumParallelRepetition.lean': {
    sha256: 'c6632bba9908e2d7148f28c110e166277425040330d5feef3a417461214d1445',
    bytes: 2683872,
  },
  'README.md': {
    sha256: 'fb1a59b06c3b855f10ef62e70c1dcf873b6f9a7641e752f5b25d917d5263f7e5',
    bytes: 3042,
  },
  'SpherePacking.lean': {
    sha256: '5e8a4d4ffa0c3b8c488f99ecedc43943dff63513d65bd5bd70d5e33beccc2c0f',
    bytes: 2096663,
  },
  'formalization.yaml': {
    sha256: '464eb3e11eb02d74eab5b5d87d0cbf8d28056ace00a85a5096850523e7e88ff5',
    bytes: 5399,
  },
  'lake-manifest.json': {
    sha256: 'd366c97598e820009831d12376d4e41004b1847ac6074ec79b15bf9e1ea09d46',
    bytes: 4141,
  },
  'lakefile.toml': {
    sha256: '9d59a0912d88d2997584b4a2dfa3cb077e06b71f91823234778e2030a1b02902',
    bytes: 1548,
  },
  'lean-toolchain': {
    sha256: '2773c517aa90b66ea8a2c52bddddf84393157797f8341be0df45294fff7fd32e',
    bytes: 25,
  },
}

export const dependencies = [
  {
    name: 'Comparator',
    url: 'https://github.com/leanprover/comparator.git',
    rev: '07bc4ea40f2266dcb861820a2ec1fa3244ed307f',
  },
  {
    name: 'mathlib',
    url: 'https://github.com/leanprover-community/mathlib4',
    rev: '81a5d257c8e410db227a6665ed08f64fea08e997',
  },
  {
    name: 'lean4export',
    url: 'https://github.com/leanprover/lean4export',
    rev: '4e7915201d3f9f04470d9eae002fa695f7cdc589',
  },
  {
    name: 'Lean4Checker',
    url: 'https://github.com/leanprover/lean4checker',
    rev: 'b7398199245524275543dec6113229c9bb4902e5',
  },
  {
    name: 'plausible',
    url: 'https://github.com/leanprover-community/plausible',
    rev: 'e12c1910fe855cbfc38803cd4e55543906d5fa62',
  },
  {
    name: 'LeanSearchClient',
    url: 'https://github.com/leanprover-community/LeanSearchClient',
    rev: 'c5d5b8fe6e5158def25cd28eb94e4141ad97c843',
  },
  {
    name: 'importGraph',
    url: 'https://github.com/leanprover-community/import-graph',
    rev: '7e9612bf0b9ee66db3cb5b9988a35afc706f5a12',
  },
  {
    name: 'proofwidgets',
    url: 'https://github.com/leanprover-community/ProofWidgets4',
    rev: '6e311e2a844da9b2cc3971187df2fe0066947b93',
  },
  {
    name: 'aesop',
    url: 'https://github.com/leanprover-community/aesop',
    rev: 'a7dbf0c63b694e47f425f3dcddbc0e178bb432d3',
  },
  {
    name: 'Qq',
    url: 'https://github.com/leanprover-community/quote4',
    rev: '38d591e778f100aec9762bb582f9c7f55f50e9dc',
  },
  {
    name: 'batteries',
    url: 'https://github.com/leanprover-community/batteries',
    rev: '023ce7d62a0531e22a5331e20b587817a80d49ff',
  },
  {
    name: 'Cli',
    url: 'https://github.com/leanprover/lean4-cli',
    rev: '88679d088c9720c27ebdf2ba4dafe17341747f94',
  },
]

const flags = new Set([
  'image',
  'cpus',
  'memory',
  'timeout-minutes',
  'build-timeout-minutes',
  'import-timeout-minutes',
  'dependency-sources',
])

export function parseOptions(args) {
  const values = {}
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]
    if (arg === '--help') return { help: true }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg)
    if (!match || !flags.has(match[1]))
      throw new Error(`Unknown option: ${arg}`)
    if (values[match[1]] !== undefined)
      throw new Error(`Repeated option: --${match[1]}`)
    const value = match[2] ?? args[++index]
    if (!value || value.startsWith('--'))
      throw new Error(`Provide a value for --${match[1]}`)
    values[match[1]] = value
  }
  const number = (name, fallback) => {
    const value = values[name] === undefined ? fallback : Number(values[name])
    if (!Number.isFinite(value) || value <= 0 || value > 1440)
      throw new Error(`--${name} must be a positive number at most 1440`)
    return value
  }
  const image = values.image || 'lemex-web-worker:local'
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:/@-]*$/.test(image))
    throw new Error('Provide a Docker image name for --image')
  const memory = values.memory || '24g'
  if (!/^[1-9][0-9]*(?:\.[0-9]+)?[kmg]$/i.test(memory))
    throw new Error('--memory must be a Docker size such as 24g')
  return {
    image,
    cpus: number('cpus', 6),
    memory,
    timeoutMs: number('timeout-minutes', 240) * 60_000,
    buildTimeoutMs: number('build-timeout-minutes', 90) * 60_000,
    importTimeoutMs: number('import-timeout-minutes', 10) * 60_000,
    dependencySources: values['dependency-sources']
      ? path.resolve(values['dependency-sources'])
      : null,
  }
}

// Ignore host Git configuration and hooks when checking or reconstructing public fixtures.
async function git(root, args, signal) {
  const result = await execute(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-C',
      root,
      ...args,
    ],
    {
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            ([name]) => !name.startsWith('GIT_'),
          ),
        ),
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_TERMINAL_PROMPT: '0',
      },
      signal,
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    },
  )
  return result.stdout.trim()
}

const publicUrl = (url) => url.replace(/\.git$/, '').replace(/\/$/, '')
const forbiddenSource = (name) =>
  name === '.lake' ||
  name === 'node_modules' ||
  name === '.env' ||
  name.startsWith('.env.') ||
  [
    '.ssh',
    '.aws',
    '.netrc',
    '.npmrc',
    '.git-credentials',
    'credentials.json',
    'secrets.json',
    'id_rsa',
    'id_ed25519',
  ].includes(name) ||
  /\.(?:olean|ilean|o|a|so|dll|dylib|trace|hash|pem|key)$/i.test(name)

async function checkSourceTree(root, relative = '') {
  for (const entry of await fs.readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    if (!relative && entry.name === '.git') continue
    const filename = path.join(relative, entry.name)
    // ProofWidgets versions an upstream JS trace. It is part of its pinned
    // public checkout, rather than a locally compiled Lean cache artifact.
    const publicTrace =
      entry.isFile() &&
      /\.(?:trace|hash)$/i.test(entry.name) &&
      (await git(root, ['ls-files', '--error-unmatch', '--', filename]).then(
        () => true,
        () => false,
      ))
    if (forbiddenSource(entry.name) && !publicTrace)
      throw new Error(
        `Source fixture contains forbidden generated or private material: ${filename}`,
      )
    if (entry.isSymbolicLink()) {
      const link = await fs.readlink(path.join(root, filename))
      const target = path.resolve(root, relative, link)
      const resolved = path.relative(root, target)
      if (
        path.isAbsolute(link) ||
        resolved.startsWith('..' + path.sep) ||
        resolved === '..' ||
        resolved
          .split(path.sep)
          .some((name) => name === '.git' || forbiddenSource(name))
      )
        throw new Error(
          `Source fixture link points outside its public sources: ${filename}`,
        )
      const canonical = path.relative(
        root,
        await fs.realpath(path.join(root, filename)),
      )
      if (
        path.isAbsolute(canonical) ||
        canonical.startsWith('..' + path.sep) ||
        canonical === '..' ||
        canonical
          .split(path.sep)
          .some((name) => name === '.git' || forbiddenSource(name))
      )
        throw new Error(
          `Source fixture link points outside its public sources: ${filename}`,
        )
    } else if (entry.isDirectory()) await checkSourceTree(root, filename)
    else if (!entry.isFile())
      throw new Error(`Source fixture contains a special file: ${filename}`)
  }
}

export async function validateDependencySources(
  directory,
  packages = dependencies,
  signal,
) {
  const root = await fs.realpath(directory)
  const entries = await fs.readdir(root)
  if (
    entries.length !== packages.length ||
    entries.some((name) => !packages.some((pkg) => pkg.name === name))
  )
    throw new Error(
      'Dependency sources must contain exactly the pinned manifest package directories',
    )
  for (const pkg of packages) {
    const checkout = path.join(root, pkg.name)
    const info = await fs.lstat(checkout)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error(`Expected a plain source directory: ${pkg.name}`)
    await checkSourceTree(checkout)
    if ((await git(checkout, ['rev-parse', 'HEAD'], signal)) !== pkg.rev)
      throw new Error(
        `Source fixture revision does not match the pin: ${pkg.name}`,
      )
    const remote = await git(checkout, ['remote', 'get-url', 'origin'], signal)
    if (publicUrl(remote) !== publicUrl(pkg.url))
      throw new Error(
        `Source fixture must use its pinned public origin: ${pkg.name}`,
      )
    if (
      await git(
        checkout,
        ['status', '--porcelain', '--untracked-files=all'],
        signal,
      )
    )
      throw new Error(`Source fixture has local changes: ${pkg.name}`)
    if (
      await git(
        checkout,
        ['ls-files', '--others', '--ignored', '--exclude-standard'],
        signal,
      )
    )
      throw new Error(
        `Source fixture contains ignored files outside the public commit: ${pkg.name}`,
      )
  }
  return root
}

export async function seedDependencySources(
  directory,
  stage,
  packages = dependencies,
  signal,
) {
  const destination = path.join(stage, '.lake', 'packages')
  await fs.mkdir(destination, { recursive: true, mode: 0o700 })
  const template = path.join(stage, '.empty-git-template')
  await fs.mkdir(template, { recursive: true, mode: 0o700 })
  try {
    for (const pkg of packages) {
      const checkout = path.join(destination, pkg.name)
      await fs.mkdir(checkout, { mode: 0o700 })
      await git(checkout, ['init', `--template=${template}`], signal)
      // Fetch only the exact public revision's objects. Never copy the input .git directory.
      await git(
        checkout,
        [
          'fetch',
          '--no-tags',
          '--depth=1',
          '--no-write-fetch-head',
          path.join(directory, pkg.name),
          pkg.rev,
        ],
        signal,
      )
      await git(checkout, ['remote', 'add', 'origin', pkg.url], signal)
      await git(checkout, ['checkout', '--detach', pkg.rev], signal)
    }
  } finally {
    await fs.rm(template, { recursive: true, force: true })
  }
}
