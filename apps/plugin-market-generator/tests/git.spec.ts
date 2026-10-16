import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it } from 'vitest'
import { generate, type GenerateOptions } from '../src/generate.ts'
import { scratch, setEnv } from './support.ts'

const REPOSITORY = 'https://git.example/team/plugins'

/** Git subprocesses run under CI load, so each test gets more than the default deadline. */
const GIT_TEST = { timeout: 60000 }

/** A Git repository fixture built without the caller's Git environment or configuration. */
function repository() {
  const dir = scratch()
  const home = scratch()
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_'))),
    HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: '1',
  }
  const git = (args: string[], time = 0) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], {
    cwd: dir, env: { ...env, GIT_AUTHOR_DATE: `${time} +0000`, GIT_COMMITTER_DATE: `${time} +0000` }, encoding: 'utf8',
  }).trim()
  git(['init', '--quiet', '--initial-branch=main'])
  const write = (files: Record<string, string>) => {
    for (const [path, contents] of Object.entries(files)) {
      mkdirSync(join(dir, path, '..'), { recursive: true })
      writeFileSync(join(dir, path), contents)
    }
  }
  const commit = (time: number) => {
    git(['add', '--all'])
    git(['commit', '--quiet', '--message', `at ${time}`], time)
    return git(['rev-parse', 'HEAD'])
  }
  return { dir, git, write, commit }
}

const bundle = (name: string, version: string, extra: object = {}) => JSON.stringify({ name, version, dsh: { bundle: { patch: './cordis.patch.yml' } }, ...extra })

/**
 * Configure Git for the generator through a private home directory: the https REPOSITORY is routed to the fixture, protocol
 * version 0 refuses commits that are not advertised ref tips, and a required filter would mark any checkout.
 */
function gitHome(fixture: string): { marker: string; temporary: string } {
  const home = scratch()
  const marker = join(home, 'filtered')
  // Git config values treat a backslash as an escape, so Windows paths are written with forward slashes.
  const slashed = (path: string) => path.replaceAll('\\', '/')
  writeFileSync(join(home, '.gitconfig'), [
    `[url "${pathToFileURL(fixture).href}"]`, `\tinsteadOf = ${REPOSITORY}`,
    '[protocol]', '\tversion = 0',
    '[filter "marker"]', `\tsmudge = touch '${slashed(marker)}'; cat`, `\tclean = touch '${slashed(marker)}'; cat`, '\trequired = true',
  ].join('\n'))
  const temporary = scratch()
  setEnv('HOME', home)
  setEnv('XDG_CONFIG_HOME', home)
  setEnv('TMPDIR', temporary)
  return { marker, temporary }
}

function options(cacheDir: string, warnings: string[]): GenerateOptions {
  return {
    sources: [{ kind: 'git', line: REPOSITORY, url: REPOSITORY }], cacheDir, registry: 'https://registry.invalid/', recordRegistry: false, title: 'T',
    inlineIconBytes: 1024, limits: { timeoutMs: 20000, maxTarballBytes: 1 << 20 }, concurrency: 1, gitTransports: ['file'],
    warn: (message) => { warnings.push(message) },
  }
}

it('lists Git versions from release tags and the default branch by reading objects', GIT_TEST, async () => {
  const repo = repository()
  repo.write({
    'package.json': JSON.stringify({ name: 'mono', private: true }),
    'pnpm-workspace.yaml': 'packages:\n  - packages/*\n',
    '.gitattributes': '* filter=marker\n',
    'packages/a/package.json': bundle('@s/a', '1.0.0'),
    'packages/b/package.json': bundle('@s/b', '0.9.0'),
  })
  const first = repo.commit(1790000000)
  repo.git(['tag', 'v1.0.0'])
  repo.git(['tag', 'not-a-version'])
  repo.write({ 'packages/b/package.json': bundle('@s/b', '2.0.0', { keywords: ['tagged'] }) })
  const second = repo.commit(1790000100)
  repo.git(['tag', '--annotate', '--message', 'b release', '@s/b@2.0.0'], 1790000150)
  repo.write({ 'packages/b/README.md': 'docs' })
  repo.commit(1790000200)
  repo.git(['tag', '1.0.0'])
  repo.git(['tag', '@s/missing@1.0.0'])
  repo.git(['tag', 'broken@'])
  mkdirSync(join(repo.dir, 'packages/c'), { recursive: true })
  symlinkSync('../a/package.json', join(repo.dir, 'packages/c/package.json'))
  repo.write({
    'packages/a/package.json': JSON.stringify({ ...JSON.parse(bundle('@s/a', '1.1.0')), author: 'Ann', icon: 'icon.svg', keywords: ['alpha'] }),
    'packages/a/locale/en.json': JSON.stringify({ meta: { title: 'Alpha', description: 'Does A' } }),
    'packages/a/icon.svg': '<svg/>',
    'packages/b/package.json': bundle('@s/b', '2.0.0', { keywords: ['head'] }),
    'packages/d/package.json': JSON.stringify({ ...JSON.parse(bundle('@s/d', '0.1.0')), peerDependencies: { '@deepseek-ai/dsh': 'workspace:>=1' } }),
  })
  const head = repo.commit(1790000300)
  repo.git(['tag', 'v2.0.0'])
  repo.git(['tag', '@s/a@1.1.0'])
  const cacheDir = scratch()
  const { marker, temporary } = gitHome(repo.dir)
  const warnings: string[] = []

  const result = await generate(options(cacheDir, warnings))
  const source = (commit: string, path: string) => ({ type: 'git', url: REPOSITORY, commit, path })
  expect(result.index.plugins).toEqual([
    {
      name: '@s/a', title: 'Alpha', description: 'Does A', icon: 'data:image/svg+xml;base64,PHN2Zy8+', author: 'Ann',
      metadata: { keywords: ['alpha'] },
      versions: [
        { version: '1.1.0', publishTimestamp: 1790000300, source: source(head, 'packages/a') },
        { version: '1.0.0', publishTimestamp: 1790000000, source: source(first, 'packages/a') },
      ],
    },
    { name: '@s/b', title: '@s/b', metadata: { keywords: ['tagged'] }, versions: [{ version: '2.0.0', publishTimestamp: 1790000100, source: source(second, 'packages/b') }] },
  ])
  expect([result.failures, warnings]).toEqual([[], [`${REPOSITORY}: @s/d@0.1.0 skipped: DSH range "workspace:>=1" is not a valid SemVer range`]])
  expect([existsSync(marker), readdirSync(temporary)]).toEqual([false, []])
  expect(await generate(options(cacheDir, warnings))).toEqual(result)

  // An untagged version follows the default branch; tagged versions and their display fields come from the cache.
  repo.write({ 'packages/b/package.json': bundle('@s/b', '2.1.0') })
  const next = repo.commit(1790000400)
  const updated = await generate(options(cacheDir, warnings))
  expect(updated.index.plugins.map(plugin => plugin.versions.map(version => [version.version, version.source.commit])))
    .toEqual([[['1.1.0', head], ['1.0.0', first]], [['2.1.0', next], ['2.0.0', second]]])
  expect(updated.index.plugins[0]).toEqual(result.index.plugins[0])
  expect(updated.index.plugins[1]).not.toHaveProperty('metadata')
})

it('reads a root package, reports repositories without one, and refuses transports that are not allowed', GIT_TEST, async () => {
  const repo = repository()
  gitHome(repo.dir)
  const warnings: string[] = []
  const run = async (defaultTransports = false) => {
    const withFile = options(scratch(), warnings)
    const { gitTransports: _file, ...defaults } = withFile
    const result = await generate(defaultTransports ? defaults : withFile)
    return [result.index.plugins, result.failures]
  }
  expect(await run()).toEqual([[], [`${REPOSITORY}: ${REPOSITORY}: no HEAD commit`]])
  repo.write({ 'README.md': 'nothing here' })
  repo.commit(1790000000)
  expect(await run(true)).toEqual([[], [expect.stringContaining("transport 'file' not allowed") as string]])
  expect(await run()).toEqual([[], []])
  repo.write({ 'package.json': JSON.stringify({ version: '1.0.0', dsh: { bundle: { patch: 'p.yml' } } }) })
  repo.commit(1790000100)
  expect(await run()).toEqual([[], []])
  repo.write({ 'package.json': bundle('dsh-root', '1.0.0') })
  const commit = repo.commit(1790000200)
  expect(await run()).toEqual([[{
    name: 'dsh-root', title: 'dsh-root', versions: [{ version: '1.0.0', publishTimestamp: 1790000200, source: { type: 'git', url: REPOSITORY, commit } }],
  }], []])
  expect(warnings).toEqual([`${REPOSITORY}: ${REPOSITORY}: no HEAD commit`, expect.stringContaining('not allowed') as string, `${REPOSITORY}: no package declares dsh.bundle`, `${REPOSITORY}: package.json has no name`])
})

it('skips a release tag it cannot read, refuses oversized manifests, and ignores Git overrides from the environment', GIT_TEST, async () => {
  const repo = repository()
  repo.write({
    'package.json': bundle('dsh-root', '1.0.0'),
  })
  repo.commit(1790000000)
  const blob = repo.git(['hash-object', '-w', 'package.json'])
  repo.git(['tag', 'v0.5.0', blob])
  gitHome(repo.dir)
  // A Git override from the caller would redirect the private repository; the user's ssh command is kept.
  setEnv('GIT_DIR', join(repo.dir, '.git'))
  setEnv('GIT_SSH_COMMAND', 'ssh -o BatchMode=yes -o ConnectTimeout=1')
  const warnings: string[] = []
  const result = await generate(options(scratch(), warnings))
  expect(result.index.plugins.map(plugin => plugin.versions.map(version => version.version))).toEqual([['1.0.0']])
  expect(result.failures).toEqual([])
  expect(warnings).toEqual([expect.stringMatching(new RegExp(`^${REPOSITORY}: ${blob}: skipped: `, 'u')) as string])

  repo.write({ 'package.json': JSON.stringify({ name: 'dsh-root', version: '1.1.0', padding: 'x'.repeat(1024 * 1024) }) })
  repo.commit(1790000100)
  const oversized = await generate(options(scratch(), warnings))
  expect(oversized.failures).toEqual([`${REPOSITORY}: package.json exceeds 1048576 bytes`])
})
