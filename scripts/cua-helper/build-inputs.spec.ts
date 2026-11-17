/** Byte-level source reuse survives unrelated releases and invalidates changed build inputs. */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { loadDesktopPackageEnvironment } from '../../apps/desktop/scripts/desktop-package-environment.mjs'
import { cuaHelperBuildKey, cuaHelperSourceDigest, cuaHelperSourceMatches, readCuaSigningSettings } from './build-inputs.ts'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cua-inputs-'))
  onTestFinished(() => { rmSync(root, { recursive: true, force: true }) })
  const git = (...args: string[]): void => { execFileSync('git', args, { cwd: root, stdio: 'pipe' }) }
  const files = {
    'package.json': JSON.stringify({ version: '1.0.0', packageManager: 'pnpm@11.28.5' }),
    'pnpm-lock.yaml': 'lockfileVersion: 9.0\n',
    'packages/experimental/cua-macos/native/Package.swift': '// swift package\n',
    'packages/experimental/cua-macos/native/Sources/Main.swift': 'print("one")\n',
    'packages/experimental/cua-macos/native/Info.plist': 'application identity',
    'scripts/cua-helper/package.ts': 'build helper',
    'apps/desktop/scripts/notarize-macos.mjs': 'notarize helper',
    '.github/workflows/cua-helper-package-macos.yml': 'build configuration',
    '.github/workflows/release-publish.yml': 'publish configuration',
    'packages/client/unrelated/src/index.ts': 'unrelated feature',
  }
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), bytes)
  }
  git('init', '--quiet')
  git('add', '.')
  return { root, git, source: join(root, 'packages/experimental/cua-macos/native/Sources/Main.swift') }
}

function copyHelperScripts(root: string): void {
  for (const file of ['scripts/cua-helper/build-inputs.ts', 'scripts/cua-helper/select-artifact.ts',
    'apps/desktop/scripts/desktop-file-settings.mjs', 'apps/desktop/scripts/desktop-release-environment.mjs', 'scripts/release/process.ts']) {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    copyFileSync(resolve(file), join(root, file))
  }
}

it('keeps identical source bytes across product versions and unrelated package edits', () => {
  const f = fixture()
  const before = cuaHelperSourceDigest(f.root)
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: '2.0.0', packageManager: 'pnpm@11.28.5' }))
  writeFileSync(join(f.root, 'packages/client/unrelated/src/index.ts'), 'another unrelated feature')
  utimesSync(f.source, new Date('2001-01-01'), new Date('2001-01-01'))
  expect(cuaHelperSourceDigest(f.root)).toBe(before)
  writeFileSync(f.source, readFileSync(f.source).toString().replace('one', 'two'))
  utimesSync(f.source, new Date('2001-01-01'), new Date('2001-01-01'))
  expect(cuaHelperSourceDigest(f.root)).not.toBe(before)
})

it.each(['add', 'delete', 'rename', 'resource', 'dependency', 'script', 'workflow', 'package manager'])(
  'invalidates %s changes', (change) => {
    const f = fixture()
    const before = cuaHelperSourceDigest(f.root)
    if (change === 'add') writeFileSync(join(dirname(f.source), 'Added.swift'), 'new source')
    if (change === 'delete') rmSync(f.source)
    if (change === 'rename') renameSync(f.source, join(dirname(f.source), 'Renamed.swift'))
    if (change === 'resource') writeFileSync(join(f.root, 'packages/experimental/cua-macos/native/Info.plist'), 'changed identity')
    if (change === 'dependency') writeFileSync(join(f.root, 'pnpm-lock.yaml'), 'changed dependency')
    if (change === 'script') writeFileSync(join(f.root, 'apps/desktop/scripts/notarize-macos.mjs'), 'changed notarization')
    if (change === 'workflow') writeFileSync(join(f.root, '.github/workflows/cua-helper-package-macos.yml'), 'changed build configuration')
    if (change === 'package manager') writeFileSync(join(f.root, 'package.json'), JSON.stringify({ packageManager: 'pnpm@12.0.0' }))
    f.git('add', '-A')
    expect(cuaHelperSourceDigest(f.root)).not.toBe(before)
  },
)

it.skipIf(process.platform === 'win32')('includes executable mode and rejects source links', () => {
  const f = fixture()
  const before = cuaHelperSourceDigest(f.root)
  chmodSync(f.source, 0o755)
  expect(cuaHelperSourceDigest(f.root)).not.toBe(before)
  rmSync(f.source)
  symlinkSync(join(f.root, 'pnpm-lock.yaml'), f.source)
  expect(() => cuaHelperSourceDigest(f.root)).toThrow('regular file')
})

it('fails on missing required tracked build inputs', () => {
  const f = fixture()
  f.git('rm', '--cached', 'scripts/cua-helper/package.ts')
  expect(() => cuaHelperSourceDigest(f.root)).toThrow('missing tracked build input')
})

it.each(['preset', 'identity', 'team', 'certificate', 'toolchain', 'source'])(
  'invalidates changed %s while credentials stay outside the build key', (change) => {
    const f = fixture()
    const certificate = join(f.root, 'signing.p12')
    writeFileSync(certificate, 'fixture encrypted certificate')
    const environment = { CSC_LINK: certificate, DSH_PACKAGING_PRESET: 'production',
      DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Fixture (ABCDEFGHIJ)', DSH_DESKTOP_MACOS_TEAM_ID: 'ABCDEFGHIJ',
      APPLE_APP_SPECIFIC_PASSWORD: 'private-password' }
    const source = cuaHelperSourceDigest(f.root)
    const run = (_command: string, args: string[]): string => args.join(' ')
    const before = cuaHelperBuildKey(source, environment, run)
    environment.APPLE_APP_SPECIFIC_PASSWORD = 'new-private-password'
    expect(cuaHelperBuildKey(source, environment, run)).toBe(before)
    if (change === 'preset') environment.DSH_PACKAGING_PRESET = 'test'
    if (change === 'identity') environment.DSH_DESKTOP_MACOS_SIGNING_IDENTITY = 'Other (ABCDEFGHIJ)'
    if (change === 'team') environment.DSH_DESKTOP_MACOS_TEAM_ID = '1234567890'
    if (change === 'certificate') writeFileSync(certificate, 'another certificate')
    const after = cuaHelperBuildKey(change === 'source' ? 'b'.repeat(64) : source, environment,
      change === 'toolchain' ? () => 'another toolchain' : run)
    expect(after).not.toBe(before)
  },
)

it('resolves the configured signing file without installing desktop dependencies or exposing parser errors', () => {
  const f = fixture()
  const config = join(f.root, 'config')
  mkdirSync(join(config, 'secrets'), { recursive: true })
  writeFileSync(join(config, 'secrets/macos-signing.env'), 'CSC_LINK=./signing.p12\nDSH_DESKTOP_MACOS_TEAM_ID=ABCDEFGHIJ\n')
  const environment = { DSH_PACKAGING_CONFIG_DIR: config, DSH_PACKAGING_PRESET: 'production' }
  expect(readCuaSigningSettings(environment)).toMatchObject({ CSC_LINK: join(config, 'secrets/signing.p12'), DSH_PACKAGING_PRESET: 'production' })
  expect(() => readCuaSigningSettings({ ...environment, DSH_PACKAGING_PRESET: 'invalid' })).toThrow('preset')
  expect(() => readCuaSigningSettings({ ...environment, DSH_PACKAGING_CONFIG_DIR: 'relative' })).toThrow('CONFIG_DIR')
})

it('loads fingerprinting and selection under plain Node with no node_modules directory', () => {
  const f = fixture()
  copyHelperScripts(f.root)
  const output = execFileSync(process.execPath, ['--input-type=module', '-e',
    "const a = await import('./scripts/cua-helper/select-artifact.ts'); const b = await import('./scripts/cua-helper/build-inputs.ts'); console.log(typeof a.selectCuaHelperArtifact, typeof b.cuaHelperSourceDigest)"],
  { cwd: f.root, encoding: 'utf8', timeout: 30_000, stdio: 'pipe' })
  expect(output.trim()).toBe('function function')
})

const repository = 'deepseek-harness/deepseek-harness'

function producerSnapshot(root: string) {
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: 'pipe' })
  git('add', '-A')
  git('-c', `core.hooksPath=${join(root, 'no-hooks')}`, '-c', 'commit.gpgsign=false', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.test', 'commit', '--quiet', '-m', 'fixture')
  const commit = git('rev-parse', 'HEAD').trim()
  const tree = git('ls-tree', '-r', '-z', 'HEAD').split('\0').filter(Boolean).map((entry) => {
    const [metadata, path] = entry.split('\t')
    const [mode, type, sha] = (metadata ?? '').split(' ')
    if (!path || !mode || !type || !sha) throw new Error('Invalid Git fixture tree entry')
    return { path, mode, type, sha }
  })
  const response = { truncated: false, tree }
  const responses: Record<string, unknown> = { [`repos/${repository}/git/trees/${commit}?recursive=1`]: response }
  for (const entry of tree.filter(entry => entry.path === 'package.json')) {
    const bytes = execFileSync('git', ['cat-file', 'blob', entry.sha], { cwd: root, stdio: 'pipe' })
    responses[`repos/${repository}/git/blobs/${entry.sha}`] = { sha: entry.sha, encoding: 'base64', content: bytes.toString('base64') }
  }
  return { commit, response, responses, api: async (path: string): Promise<unknown> => {
    if (!(path in responses)) throw new Error(`Unexpected GitHub fixture request ${path}`)
    return responses[path]
  } }
}

it('compares GitHub commit objects independently of artifact claims while allowing a root version bump', async () => {
  const f = fixture()
  const previous = producerSnapshot(f.root)
  expect(await cuaHelperSourceMatches(f.root, repository, previous.commit, previous.api)).toBe(true)
  writeFileSync(join(f.root, 'package.json'), JSON.stringify({ version: '2.0.0', packageManager: 'pnpm@11.28.5' }))
  writeFileSync(join(f.root, 'packages/client/unrelated/src/index.ts'), 'another unrelated feature')
  expect(await cuaHelperSourceMatches(f.root, repository, previous.commit, previous.api)).toBe(true)
  writeFileSync(f.source, 'changed native code')
  expect(await cuaHelperSourceMatches(f.root, repository, previous.commit, previous.api)).toBe(false)
})

it.each(['helper workflow', 'publish workflow', 'packaging script', 'manifest lifecycle', 'npm config', 'patch', 'tracked dependency', 'deleted file'])(
  'rejects independent producer source proof after a changed %s', async (change) => {
    const f = fixture()
    const previous = producerSnapshot(f.root)
    const digest = cuaHelperSourceDigest(f.root)
    if (change === 'helper workflow') writeFileSync(join(f.root, '.github/workflows/cua-helper-package-macos.yml'), 'forged uploader')
    if (change === 'publish workflow') writeFileSync(join(f.root, '.github/workflows/release-publish.yml'), 'forged caller')
    if (change === 'packaging script') writeFileSync(join(f.root, 'scripts/cua-helper/package.ts'), 'forged metadata')
    if (change === 'manifest lifecycle') writeFileSync(join(f.root, 'package.json'), JSON.stringify({
      version: '1.0.0', packageManager: 'pnpm@11.28.5', scripts: { postinstall: 'unexpected code' },
    }))
    if (change === 'npm config') writeFileSync(join(f.root, '.npmrc'), 'node-options=--require=./unexpected.cjs')
    if (change === 'patch') {
      mkdirSync(join(f.root, 'patches'))
      writeFileSync(join(f.root, 'patches/dependency.patch'), 'changed package code')
    }
    if (change === 'tracked dependency') {
      mkdirSync(join(f.root, 'apps/desktop/node_modules/unexpected'), { recursive: true })
      writeFileSync(join(f.root, 'apps/desktop/node_modules/unexpected/index.js'), 'unexpected dependency code')
      f.git('add', '--force', 'apps/desktop/node_modules')
    }
    if (change === 'deleted file') rmSync(f.source)
    f.git('add', '-A')
    expect(cuaHelperSourceDigest(f.root)).not.toBe(digest)
    expect(await cuaHelperSourceMatches(f.root, repository, previous.commit, previous.api)).toBe(false)
  },
)

it('stops source comparison when GitHub returns an incomplete tree', async () => {
  const f = fixture()
  const previous = producerSnapshot(f.root)
  previous.response.truncated = true
  await expect(cuaHelperSourceMatches(f.root, repository, previous.commit, previous.api)).rejects.toThrow('incomplete commit tree')
})

it.each(['test', 'production'])('computes the same %s build key through selection and packaging configuration readers', (preset) => {
  const f = fixture()
  const config = join(f.root, 'config')
  mkdirSync(join(config, 'presets'), { recursive: true })
  mkdirSync(join(config, 'secrets'))
  writeFileSync(join(config, 'presets', `${preset}.env`), `DSH_DESKTOP_AUTO_UPDATE_ENV=${preset}\n`)
  writeFileSync(join(config, 'secrets/signing.p12'), 'fixture certificate')
  writeFileSync(join(config, 'secrets/macos-signing.env'), [
    'CSC_LINK=./signing.p12', 'CSC_KEY_PASSWORD=fixture-password', 'DSH_DESKTOP_MACOS_TEAM_ID=ABCDEFGHIJ',
    'DSH_DESKTOP_MACOS_SIGNING_IDENTITY=Fixture (ABCDEFGHIJ)',
  ].join('\n'))
  const environment = { DSH_PACKAGING_CONFIG_DIR: config, DSH_PACKAGING_PRESET: preset }
  const source = cuaHelperSourceDigest(f.root)
  const run = (_command: string, args: string[]): string => args.join(' ')
  expect(cuaHelperBuildKey(source, readCuaSigningSettings(environment), run))
    .toBe(cuaHelperBuildKey(source, loadDesktopPackageEnvironment('darwin', environment), run))
})

// A private POSIX PATH exposes only Git, so successful CLI execution cannot depend on gh.
it.skipIf(process.platform === 'win32').each(['match', 'miss', 'api failure', 'missing token'])(
  'runs the plain-Node selector entry with %s and without gh or node_modules', (scenario) => {
    const f = fixture()
    copyHelperScripts(f.root)
    const snapshot = producerSnapshot(f.root)
    const key = 'a'.repeat(64)
    const base = `repos/${repository}/actions/runs/123`
    Object.assign(snapshot.responses, {
      [base]: { run_attempt: 2 },
      [`${base}/attempts/2`]: { id: 123, run_attempt: 2, status: 'completed', conclusion: 'success',
        event: 'workflow_dispatch', path: '.github/workflows/cua-helper-package-macos.yml', head_sha: snapshot.commit,
        repository: { full_name: repository }, head_repository: { full_name: repository } },
      [`${base}/jobs?filter=all&per_page=100`]: { jobs: [{ name: 'package', conclusion: 'success', run_attempt: 2 }] },
      [`${base}/artifacts?per_page=100`]: { artifacts: scenario === 'match'
        ? [{ id: 456, name: `cua-helper-macos-123-2-${key}`, expired: false, size_in_bytes: 4096 }] : [] },
    })
    const data = join(f.root, 'responses.json')
    writeFileSync(data, JSON.stringify(snapshot.responses))
    const bin = join(f.root, 'git-only-bin')
    mkdirSync(bin)
    const git = execFileSync('/usr/bin/which', ['git'], { encoding: 'utf8' }).trim()
    symlinkSync(git, join(bin, 'git'))
    const preload = join(f.root, 'mock-github.mjs')
    writeFileSync(preload, `import { readFileSync } from 'node:fs';
const data = JSON.parse(readFileSync(process.env.FIXTURE_API_DATA, 'utf8'));
globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  if (url.origin !== 'https://api.github.com' || new Headers(options.headers).get('authorization') !== 'Bearer fixture-token') {
    throw new Error('unexpected GitHub request');
  }
  if (process.env.FIXTURE_API_FAILURE === '1') return new Response('fixture API failure', { status: 503 });
  const path = url.pathname.slice(1) + url.search;
  if (path.includes('/workflows/')) return Response.json({ workflow_runs: path.includes('cua-helper-package-macos.yml') ? [{ id: 123 }] : [] });
  if (!(path in data)) throw new Error('unexpected GitHub path');
  return Response.json(data[path]);
};
`)
    const output = join(f.root, 'outputs')
    const summary = join(f.root, 'summary')
    const result = spawnSync(process.execPath, ['--import', preload, join(f.root, 'scripts/cua-helper/select-artifact.ts')], {
      cwd: f.root, encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: '', PATH: bin, GH_TOKEN: scenario === 'missing token' ? '' : 'fixture-token',
        GITHUB_API_URL: 'https://api.github.com', GITHUB_REPOSITORY: repository, GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary, CUA_MACOS_RUN_ID: '', CUA_BUILD_KEY: key,
        FIXTURE_API_DATA: data, FIXTURE_API_FAILURE: scenario === 'api failure' ? '1' : '0' },
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(existsSync(join(bin, 'gh'))).toBe(false)
    expect(existsSync(join(f.root, 'node_modules'))).toBe(false)
    if (scenario === 'api failure' || scenario === 'missing token') {
      expect(result.status).toBe(1)
      expect(result.stderr).toContain(scenario === 'missing token' ? 'GH_TOKEN is required' : 'HTTP 503')
      expect(existsSync(output)).toBe(false)
      expect(existsSync(summary)).toBe(false)
    } else {
      expect(result.status, result.stderr).toBe(0)
      expect(readFileSync(output, 'utf8')).toBe(scenario === 'match' ? 'artifact-id=456\nrun-id=123\n' : 'artifact-id=\nrun-id=\n')
      expect(readFileSync(summary, 'utf8')).toContain(scenario === 'match' ? '跳过依赖安装' : '未找到')
    }
  },
)

it('matches Git blobs when tracked attributes require CRLF checkout bytes', async () => {
  const f = fixture()
  const path = join(f.root, 'apps/desktop/scripts/fixture.cmd')
  writeFileSync(join(f.root, '.gitattributes'), '*.cmd text eol=crlf\n')
  writeFileSync(path, '@echo off\necho fixture\n')
  const previous = producerSnapshot(f.root)
  writeFileSync(path, '@echo off\r\necho fixture\r\n')
  expect(await cuaHelperSourceMatches(f.root, repository, previous.commit, previous.api)).toBe(true)
  writeFileSync(join(f.root, '.gitattributes'), '*.cmd text eol=lf\n')
  expect(await cuaHelperSourceMatches(f.root, repository, previous.commit, previous.api)).toBe(false)
})
