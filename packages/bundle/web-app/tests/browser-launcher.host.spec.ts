/** Native browser helper handoff keeps Harness credentials out of the child environment. */
import { EventEmitter } from 'node:events'
import { spawn, type ChildProcess } from 'node:child_process'
import { PassThrough } from 'node:stream'
import { afterEach, expect, it, vi } from 'vitest'
import { internals } from '../src/index.ts'

vi.mock('node:child_process', async importOriginal => ({
  ...await importOriginal<typeof import('node:child_process')>(), spawn: vi.fn(),
}))
afterEach(() => { vi.restoreAllMocks(); vi.mocked(spawn).mockReset(); vi.unstubAllEnvs() })

type BrowserLauncher = ChildProcess & { stderr: PassThrough; kill: ReturnType<typeof vi.fn<() => boolean>> }
function launcher(): BrowserLauncher {
  return Object.assign(new EventEmitter(), { stderr: new PassThrough(), kill: vi.fn(() => true) }) as BrowserLauncher
}

it('scrubs the helper environment and reports spawn or exit failures', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'must-not-reach-browser')
  vi.stubEnv('DSH_HOME', '/must-not-reach-browser')
  const completed = launcher()
  vi.mocked(spawn).mockReturnValueOnce(completed)
  const completion = internals.openBrowser('http://127.0.0.1:4567')
  const [command, args, options] = vi.mocked(spawn).mock.calls[0]!
  expect(command).toBe(process.execPath)
  expect(args).toEqual(['--input-type=module', '--eval', expect.stringContaining('await import('), '--', 'http://127.0.0.1:4567'])
  expect(args?.[2]).toContain("if (process.platform === 'win32')")
  expect(args?.[2]).toContain('launcher.ref()')
  expect(options?.env).not.toHaveProperty('DEEPSEEK_API_KEY')
  expect(options?.env).not.toHaveProperty('DSH_HOME')
  expect(options?.env?.PATH).toBe(process.env.PATH)
  expect(options?.stdio).toEqual(['ignore', 'inherit', 'pipe'])
  completed.emit('close', 0)
  await expect(completion).resolves.toBeUndefined()
  expect(completed.listenerCount('error')).toBe(0)

  const withStderr = launcher()
  vi.mocked(spawn).mockReturnValueOnce(withStderr)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const withStderrDone = internals.openBrowser('http://127.0.0.1:4567')
  withStderr.stderr.write('launcher note\n')
  withStderr.emit('close', 0)
  await expect(withStderrDone).resolves.toBeUndefined()
  expect(stderr).toHaveBeenCalledWith('launcher note\n')

  const detailed = launcher()
  vi.mocked(spawn).mockReturnValueOnce(detailed)
  const detail = expect(internals.openBrowser('http://127.0.0.1:4567')).rejects.toThrow('desktop unavailable')
  detailed.stderr.write('Error: desktop unavailable\n    at fixture')
  detailed.emit('close', 1)
  await detail

  const failed = launcher()
  vi.mocked(spawn).mockReturnValueOnce(failed)
  const failure = expect(internals.openBrowser('http://127.0.0.1:4567')).rejects.toThrow('exited with code 3')
  failed.emit('close', 3)
  await failure

  const errored = launcher()
  vi.mocked(spawn).mockReturnValueOnce(errored)
  const error = expect(internals.openBrowser('http://127.0.0.1:4567')).rejects.toThrow('spawn failed')
  errored.emit('error', new Error('spawn failed'))
  await error
  expect(errored.listenerCount('close')).toBe(0)
})

it('stops a helper when cancellation occurs during spawn and retains its non-Error reason', async () => {
  const child = launcher()
  const controller = new AbortController()
  const reason = 'startup scope left'
  vi.mocked(spawn).mockImplementationOnce(() => {
    controller.abort(reason)
    return child
  })
  const pending = internals.openBrowser('http://127.0.0.1:4567', controller.signal)
  const rejected = expect(pending).rejects.toMatchObject({ message: 'Browser handoff cancelled', cause: reason })
  expect(child.kill).toHaveBeenCalledOnce()
  let settled = false
  void pending.catch(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  child.emit('close', null)
  await rejected
  expect(child.listenerCount('error')).toBe(0)
})

it('stops the helper and joins its exit when startup is cancelled', async () => {
  const child = launcher()
  vi.mocked(spawn).mockReturnValueOnce(child)
  const signal = new AbortController()
  const reason = new Error('startup scope left')
  const pending = internals.openBrowser('http://127.0.0.1:4567', signal.signal)
  const rejected = expect(pending).rejects.toBe(reason)
  signal.abort(reason)
  expect(child.kill).toHaveBeenCalledOnce()
  let settled = false
  void pending.catch(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  child.emit('close', null)
  await rejected
})
