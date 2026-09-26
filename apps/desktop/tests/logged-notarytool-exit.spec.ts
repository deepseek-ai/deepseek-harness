import { expect, it, vi } from 'vitest'
import { runLoggedNotarytool } from '../scripts/logged-notarytool.mjs'

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
  await expect(runLoggedNotarytool(args)).rejects.toThrow('upload failed')
  expect(command).toHaveBeenCalledOnce()
})
