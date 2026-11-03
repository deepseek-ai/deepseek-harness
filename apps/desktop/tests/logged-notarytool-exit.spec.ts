import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it, vi } from 'vitest'
import { runLoggedNotarytool } from '../scripts/logged-notarytool.mjs'
import { createPackagingRun } from '../scripts/packaging-run.mjs'

const command = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<{ stdout: string; stderr: string }>>())
vi.mock('node:child_process', async (importOriginal) => {
  const { promisify } = await import('node:util')
  return {
    ...await importOriginal<typeof import('node:child_process')>(),
    execFile: Object.assign(() => {}, { [promisify.custom]: command }),
  }
})

const id = '11111111-2222-3333-4444-555555555555'
const args = ['submit', '/fixture/app.zip', '--keychain-profile', 'fixture', '--wait', '--output-format', 'json']

it('passes Apple rejection JSON from a nonzero wait exit back to electron-notarize for diagnostic retrieval', async () => {
  command.mockReset()
  command.mockResolvedValueOnce({ stdout: JSON.stringify({ id }), stderr: '' })
  command.mockRejectedValueOnce(Object.assign(new Error('notarytool exited 65'), {
    code: 65, stdout: JSON.stringify({ id, status: 'Invalid' }), stderr: '',
  }))
  expect(JSON.parse(await runLoggedNotarytool(args))).toEqual({ id, status: 'Invalid' })
  expect(command).toHaveBeenCalledTimes(2)
})

it('does not treat failed upload output as a completed submission', async () => {
  command.mockReset()
  command.mockRejectedValueOnce(Object.assign(new Error('upload failed'), {
    code: 1, stdout: JSON.stringify({ id }), stderr: '',
  }))
  const work = runLoggedNotarytool(args)
  await expect(work).rejects.toThrow('notarytool submit failed (code: 1')
  await expect(work).rejects.toHaveProperty('cause.message', 'upload failed')
  expect(command).toHaveBeenCalledOnce()
})

it.each([false, true])('prints the redacted Apple failure with a journal=%s and leaves stdout for protocol replies', async (recorded) => {
  const root = await mkdtemp(join(tmpdir(), 'notary-cli-'))
  const directory = recorded ? createPackagingRun(root, {}).directory : undefined
  const savedArgv = process.argv
  const savedExit = process.exitCode
  const savedDirectory = process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
  try {
    if (directory === undefined) delete process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
    else process.env.DSH_DESKTOP_PACKAGING_RUN_DIR = directory
    process.argv = [process.execPath, fileURLToPath(new URL('../scripts/logged-notarytool.mjs', import.meta.url)),
      'submit', '/fixture/app.zip', '--apple-id', 'private@example.test', '--password', 'secret-sentinel',
      '--team-id', 'private-team', '--wait', '--output-format', 'json']
    command.mockReset()
    command.mockRejectedValueOnce(Object.assign(new Error('connection closed: private@example.test secret-sentinel private-team'), {
      code: 69, signal: null, stdout: 'Apple response: secret-sentinel', stderr: 'HTTP 503 Service Unavailable',
    }))
    vi.resetModules()
    await import('../scripts/logged-notarytool.mjs')
    expect(command).toHaveBeenCalledOnce()
    expect(process.exitCode).toBe(1)
    expect(stdout).not.toHaveBeenCalled()
    const output = stderr.mock.calls.map(([chunk]) => String(chunk)).join('')
    const diagnostics = [output, ...directory === undefined ? [] : [await readFile(join(directory, 'events.jsonl'), 'utf8')]]
    for (const diagnostic of diagnostics) {
      expect(diagnostic).toContain('code: 69')
      expect(diagnostic).toContain('Apple response: [REDACTED]')
      expect(diagnostic).toContain('HTTP 503 Service Unavailable')
      expect(diagnostic).toContain('connection closed')
      for (const secret of ['private@example.test', 'secret-sentinel', 'private-team']) expect(diagnostic).not.toContain(secret)
    }
    expect(output.includes('events.jsonl')).toBe(recorded)
  } finally {
    process.argv = savedArgv
    process.exitCode = savedExit
    if (savedDirectory === undefined) delete process.env.DSH_DESKTOP_PACKAGING_RUN_DIR
    else process.env.DSH_DESKTOP_PACKAGING_RUN_DIR = savedDirectory
    stderr.mockRestore()
    stdout.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
