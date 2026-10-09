/** Official installation targets follow the actual CLI installation and its workspace packages. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { officialBundleInstallTarget } from '../src/official-install-target.ts'

const name = '@deepseek-ai/dsh-subagent-codex'
const version = '0.2.1-alpha.1'

function fixture() {
  const temporary = mkdtempSync(join(tmpdir(), 'official-target-'))
  onTestFinished(() => { rmSync(temporary, { recursive: true, force: true }) })
  const root = realpathSync(temporary)
  const anchor = join(root, 'apps', 'cli', 'package.json')
  mkdirSync(dirname(anchor), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-root' }))
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version, dependencies: { '@deepseek-ai/dsh-app-boot': 'workspace:*' } }))
  const directory = join(root, 'packages', 'relocated', 'native-provider')
  mkdirSync(join(directory, 'lib'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name, version, main: 'lib/index.js', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(directory, 'lib', 'index.js'), 'export function apply() {}\n')
  writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n')
  return { root, anchor, directory }
}

it('offers an exact prerelease registry target for a packed installation inside a checkout', () => {
  const { anchor } = fixture()
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version, dependencies: { '@deepseek-ai/dsh-app-boot': version } }))
  expect(officialBundleInstallTarget(name, anchor, version)).toEqual({ spec: `${name}@${version}`, version })
})

it('keeps an installation without workspace dependencies on the registry path', () => {
  const { anchor } = fixture()
  writeFileSync(anchor, JSON.stringify({ name: '@deepseek-ai/dsh', version }))
  expect(officialBundleInstallTarget(name, anchor, version)).toEqual({ spec: `${name}@${version}`, version })
})

it('finds the package by manifest name rather than assuming its workspace directory', () => {
  const { anchor, directory } = fixture()
  expect(officialBundleInstallTarget(name, anchor, version)).toEqual({ spec: `link:${directory}`, version })
})

it('follows the CLI directory link used by an unpackaged Desktop application', () => {
  const { root, anchor, directory } = fixture()
  const link = join(root, 'desktop-runtime', 'node_modules', '@deepseek-ai', 'dsh')
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(dirname(anchor), link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(officialBundleInstallTarget(name, join(link, 'package.json'), version)).toEqual({ spec: `link:${directory}`, version })
})

it.each(['missing', 'wrong-name', 'wrong-location'])('refuses a source CLI with a %s workspace root', (kind) => {
  const { root, anchor } = fixture()
  if (kind === 'missing') rmSync(join(root, 'package.json'))
  if (kind === 'wrong-name') writeFileSync(join(root, 'package.json'), '{"name":"unrelated"}')
  const selected = kind === 'wrong-location' ? join(root, 'package.json') : anchor
  if (kind === 'wrong-location') writeFileSync(selected, readFileSync(anchor))
  expect(() => officialBundleInstallTarget(name, selected, version)).toThrow('requires its complete workspace checkout')
})

it.each(['missing', 'duplicate'])('refuses a %s workspace package without offering a registry fallback', (kind) => {
  const { root, anchor, directory } = fixture()
  if (kind === 'missing') rmSync(directory, { recursive: true })
  else {
    const duplicate = join(root, 'packages', 'elsewhere', 'duplicate')
    mkdirSync(duplicate, { recursive: true })
    writeFileSync(join(duplicate, 'package.json'), readFileSync(join(directory, 'package.json')))
  }
  expect(() => officialBundleInstallTarget(name, anchor, version)).toThrow('expected one workspace package')
})

it.each([
  { version: '0.1.0' }, { private: true }, { dsh: {} },
])('refuses a workspace package with invalid release or bundle metadata: %j', (changes) => {
  const { anchor, directory } = fixture()
  const file = join(directory, 'package.json')
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), ...changes }))
  expect(() => officialBundleInstallTarget(name, anchor, version)).toThrow('must declare a public bundle at DSH version')
})

it.each(['missing-main', 'missing-output', 'directory-output'])('refuses an unbuilt workspace package: %s', (kind) => {
  const { anchor, directory } = fixture()
  if (kind === 'missing-main') {
    const file = join(directory, 'package.json')
    writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, 'utf8')), main: undefined }))
  } else {
    const output = join(directory, 'lib', 'index.js')
    rmSync(output)
    if (kind === 'directory-output') mkdirSync(output)
  }
  expect(() => officialBundleInstallTarget(name, anchor, version)).toThrow('run pnpm install and pnpm run build')
})

it.each(['missing', 'directory'])('refuses an unavailable bundle patch: %s', (kind) => {
  const { anchor, directory } = fixture()
  const patch = join(directory, 'cordis.patch.yml')
  rmSync(patch)
  if (kind === 'directory') mkdirSync(patch)
  expect(() => officialBundleInstallTarget(name, anchor, version)).toThrow('bundle patch')
})
