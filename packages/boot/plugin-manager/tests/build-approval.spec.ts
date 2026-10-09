/** Pending script permissions survive cleanup and preserve unrelated workspace settings. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, it, onTestFinished } from 'vitest'
import { parse } from 'yaml'
import { approveBuilds, recordPendingBuilds } from '../src/build-approval.ts'

function fixture(text?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'build-approval-'))
  onTestFinished(() => { rmSync(dir, { recursive: true, force: true }) })
  const filename = join(dir, 'pnpm-workspace.yaml')
  if (text !== undefined) writeFileSync(filename, text)
  return { dir, filename }
}

it('approves only named pending packages and preserves comments, decisions and settings', async () => {
  const { dir, filename } = fixture('# profile settings\nother: &unrelated value\ncopy: *unrelated\nnodeLinker: hoisted\nallowBuilds:\n  native: set this to true or false\n  "@scope/other": set this to true or false\n  trusted: true\n  denied: false\n  "@scope/*": set this to true or false\n')
  expect(await recordPendingBuilds(dir, '')).toEqual(['native', '@scope/other'])
  await approveBuilds(dir, ['native'])
  const text = readFileSync(filename, 'utf8')
  expect(text).toContain('# profile settings')
  expect(parse(text)).toMatchObject({ nodeLinker: 'hoisted', allowBuilds: { native: true, trusted: true, denied: false } })
  expect(await recordPendingBuilds(dir, '')).toEqual(['@scope/other'])
})

it.each(['missing', 'denied', '*', '--all'])('rejects an unlisted approval atomically: %s', async (name) => {
  const original = 'allowBuilds:\n  native: set this to true or false\n  denied: false\n'
  const { dir, filename } = fixture(original)
  await expect(approveBuilds(dir, ['native', name])).rejects.toThrow('stale-approval')
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('preserves pnpm file dependency selectors verbatim', async () => {
  const name = '@scope/addon@file:../local addon'
  const { dir, filename } = fixture(`allowBuilds:\n  '${name}': set this to true or false\n`)
  expect(await recordPendingBuilds(dir, '')).toEqual([name])
  await approveBuilds(dir, [name])
  expect(parse(readFileSync(filename, 'utf8'))).toEqual({ allowBuilds: { [name]: true } })
})

it.each([undefined, '{}\n', 'nodeLinker: hoisted\n', 'allowBuilds: {}\n'])('has no pending approval without pnpm placeholders: %s', async (text) => {
  const { dir } = fixture(text)
  expect(await recordPendingBuilds(dir, '')).toEqual([])
  await approveBuilds(dir, [])
})

it.each(['[', '[]\n', 'allowBuilds: false\n'])('rejects malformed workspace settings without rewriting them: %s', async (text) => {
  const { dir, filename } = fixture(text)
  await expect(recordPendingBuilds(dir, '')).rejects.toThrow()
  await expect(approveBuilds(dir, ['native'])).rejects.toThrow()
  expect(readFileSync(filename, 'utf8')).toBe(text)
})

it('reports unreadable workspace settings', async () => {
  const { dir, filename } = fixture()
  mkdirSync(filename)
  await expect(recordPendingBuilds(dir, '')).rejects.toThrow()
})

it.each([
  'allowBuilds:\n  native: &pending set this to true or false\n  other: *pending\n',
  'allowBuilds: &builds\n  native: set this to true or false\nshared: *builds\n',
  'shared: &pending set this to true or false\nallowBuilds:\n  native: *pending\n',
])('rejects shared YAML approval nodes without changing permissions: %s', async (original) => {
  const { dir, filename } = fixture(original)
  await expect(approveBuilds(dir, ['native'])).rejects.toThrow()
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('records the ignored build scripts a non-interactive run reported', async () => {
  const { dir, filename } = fixture('# profile settings\nnodeLinker: hoisted\n')
  const output = [
    'Progress: resolved 2, reused 2, downloaded 0, added 2, done',
    '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: native@1.0.0, @scope/other@file:../other, @scope/*',
    '',
    'Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.',
  ].join('\n')

  expect(await recordPendingBuilds(dir, output)).toEqual(['native@1.0.0', '@scope/other@file:../other'])
  const text = readFileSync(filename, 'utf8')
  expect(text).toContain('# profile settings')
  expect(parse(text)).toMatchObject({
    nodeLinker: 'hoisted',
    allowBuilds: { 'native@1.0.0': 'set this to true or false', '@scope/other@file:../other': 'set this to true or false' },
  })
  expect(await recordPendingBuilds(dir, output)).toEqual(['native@1.0.0', '@scope/other@file:../other'])
  await approveBuilds(dir, ['native@1.0.0'])
  expect(parse(readFileSync(filename, 'utf8'))).toMatchObject({ allowBuilds: { 'native@1.0.0': true } })
})

it.each([
  ['no report', 'Progress: resolved 1, reused 1, downloaded 0, added 1, done\n'],
  ['an empty report', '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: \n'],
  ['only wildcards', '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @scope/*, native@?\n'],
])('leaves the profile settings untouched for %s', async (_label, output) => {
  const original = 'allowBuilds:\n  decided: true\n'
  const { dir, filename } = fixture(original)
  expect(await recordPendingBuilds(dir, output)).toEqual([])
  expect(readFileSync(filename, 'utf8')).toBe(original)
})

it('preserves approval keys that are not package names', async () => {
  const { dir, filename } = fixture('allowBuilds:\n  1: true\n')
  expect(await recordPendingBuilds(dir, '[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: native@1.0.0\n'))
    .toEqual(['native@1.0.0'])
  expect(parse(readFileSync(filename, 'utf8'))).toMatchObject({
    allowBuilds: { 1: true, 'native@1.0.0': 'set this to true or false' },
  })
})
