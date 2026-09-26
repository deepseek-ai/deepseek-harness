import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { runLoggedNotarytool } from '../scripts/logged-notarytool.mjs'
import { createPackagingRun } from '../scripts/packaging-run.mjs'

const id = '11111111-2222-3333-4444-555555555555'
const args = ['submit', '/fixture/app.zip', '--apple-id', 'private@example.test', '--password', 'secret-value', '--team-id', 'TEAM', '--wait', '--output-format', 'json']
async function fixture(action: (directory: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'notary-log-'))
  try { await action(createPackagingRun(root, {}).directory) } finally { await rm(root, { recursive: true, force: true }) }
}

it('finishes submission before starting wait and records the ID and separate timings', async () => {
  await fixture(async (directory) => {
    const uploaded = Promise.withResolvers<string>()
    const execute = vi.fn(async (command: readonly string[]) => command[0] === 'submit' ? uploaded.promise : JSON.stringify({ id, status: 'Accepted' }))
    const work = runLoggedNotarytool(args, directory, execute)
    try {
      expect(execute).toHaveBeenCalledExactlyOnceWith(args.filter(arg => arg !== '--wait').concat('--no-wait'))
      expect(await readFile(join(directory, 'events.jsonl'), 'utf8')).not.toContain('notarytool:wait')
    } finally { uploaded.resolve(JSON.stringify({ id })) }
    expect(JSON.parse(await work)).toEqual({ id, status: 'Accepted' })
    expect(execute.mock.calls[1]![0]).toEqual(['wait', id, '--apple-id', 'private@example.test', '--password', 'secret-value', '--team-id', 'TEAM', '--output-format', 'json'])
    const log = await readFile(join(directory, 'events.jsonl'), 'utf8')
    expect(log).toContain('notary-submission')
    expect(log).toContain('notarytool:upload:app.zip')
    expect(log).toContain('notarytool:wait:app.zip')
    expect(log).toContain('elapsedMs')
    expect(log).not.toContain('private@example.test')
    expect(log).not.toContain('secret-value')
  })
})

it('records a redacted upload error without starting wait', async () => {
  await fixture(async (directory) => {
    const execute = vi.fn(async () => { throw new Error('rejected secret-value private@example.test') })
    await expect(runLoggedNotarytool(args, directory, execute)).rejects.toThrow('rejected')
    expect(execute).toHaveBeenCalledOnce()
    const log = await readFile(join(directory, 'events.jsonl'), 'utf8')
    expect(log).toContain('"success":false')
    expect(log).not.toContain('secret-value')
    expect(log).not.toContain('private@example.test')
  })
})

it.each(['Invalid', 'Rejected'])('preserves %s for electron-notarize rejection handling', async (status) => {
  const execute = vi.fn(async (command: readonly string[]) => JSON.stringify(command[0] === 'submit' ? { id } : { id, status }))
  await fixture(async (directory) => {
    expect(JSON.parse(await runLoggedNotarytool(args, directory, execute))).toEqual({ id, status })
    const log = await readFile(join(directory, 'events.jsonl'), 'utf8')
    expect(log).toContain('\"success\":false')
    expect(log).toContain(status)
  })
})

it('rejects missing submission IDs and mismatched wait results', async () => {
  await expect(runLoggedNotarytool(args, undefined, async () => '{}')).rejects.toThrow('submission ID')
  await expect(runLoggedNotarytool(args, undefined, async command => JSON.stringify(command[0] === 'submit' ? { id } : { id: 'other', status: 'Accepted' }))).rejects.toThrow('different submission ID')
})

it.each([
  ['--key', '/private/AuthKey.p8', '--key-id', 'KEY123', '--issuer', id],
  ['--keychain-profile', 'release', '--keychain', '/private/release.keychain'],
])('preserves API-key and keychain authentication when waiting: %j', async (...auth) => {
  const execute = vi.fn(async () => JSON.stringify({ id, status: 'Accepted' }))
  await runLoggedNotarytool(['submit', '/fixture/release.dmg', ...auth, '--wait', '--output-format', 'json'], undefined, execute)
  expect(execute.mock.calls[1]).toEqual([['wait', id, ...auth, '--output-format', 'json']])
})

it('retains redacted Apple diagnostics and passes the original result to electron-notarize', async () => {
  await fixture(async (directory) => {
    const output = 'diagnostic for private@example.test'
    const command = ['log', id, '--apple-id', 'private@example.test']
    expect(await runLoggedNotarytool(command, directory, async () => output)).toBe(output)
    const log = await readFile(join(directory, 'events.jsonl'), 'utf8')
    expect(log).toContain('notary-diagnostics')
    expect(log).toContain('[REDACTED]')
    expect(log).not.toContain('private@example.test')
  })
})
