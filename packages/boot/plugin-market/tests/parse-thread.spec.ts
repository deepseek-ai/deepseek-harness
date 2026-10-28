/** Worker lifecycle of index parsing, with a scripted Worker. */
import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'

const workers: FakeWorker[] = []

class FakeWorker extends EventEmitter {
  readonly terminate = vi.fn(() => Promise.resolve(0))
  constructor(readonly entry: URL, readonly options: { workerData: unknown; transferList: unknown[] }) {
    super()
    workers.push(this)
  }
}

vi.mock('node:worker_threads', () => ({ Worker: FakeWorker }))

const { parseIndexInWorker } = await import('../src/parse-thread.ts')

afterEach(() => { workers.length = 0 })

function start(signal = new AbortController().signal) {
  const body = new Uint8Array([1, 2, 3])
  const result = parseIndexInWorker(body, 'https://m.example/i.json', signal)
  const worker = workers.at(-1) as FakeWorker
  return { body, result, worker }
}

it('transfers the body, resolves with the first message, and terminates the Worker', async () => {
  const { body, result, worker } = start()
  expect(worker.options.workerData).toEqual({ body, url: 'https://m.example/i.json' })
  expect(worker.options.transferList).toEqual([body.buffer])
  worker.emit('message', { ok: false, path: '$', reason: 'r', message: 'r' })
  worker.emit('exit', 1)
  await expect(result).resolves.toEqual({ ok: false, path: '$', reason: 'r', message: 'r' })
  expect(worker.terminate).toHaveBeenCalledOnce()
})

it('settles when termination fails', async () => {
  const { result, worker } = start()
  worker.terminate.mockImplementationOnce(() => Promise.reject(new Error('stuck')))
  worker.emit('message', { ok: true, index: {} })
  await expect(result).resolves.toEqual({ ok: true, index: {} })
})

it.each([
  null,
  { index: {} },
  { ok: true },
  { ok: true, index: null },
  { ok: false, path: '$', reason: 'r' },
])('refuses the Worker message %j', async (message) => {
  const { result, worker } = start()
  worker.emit('message', message)
  await expect(result).rejects.toThrow('index parser reported an unexpected value')
})

it('rejects when the Worker fails or exits without a result', async () => {
  const failing = start()
  failing.worker.emit('error', new Error('crashed'))
  await expect(failing.result).rejects.toThrow('crashed')
  const exiting = start()
  exiting.worker.emit('exit', 3)
  await expect(exiting.result).rejects.toThrow('index parser exited before reporting a result (code 3)')
})

it('terminates the Worker on abort and refuses an aborted signal', async () => {
  const controller = new AbortController()
  const { result, worker } = start(controller.signal)
  controller.abort(new Error('disposed'))
  await expect(result).rejects.toThrow('disposed')
  expect(worker.terminate).toHaveBeenCalledOnce()
  await expect(parseIndexInWorker(new Uint8Array(1), 'https://m.example/i.json', controller.signal)).rejects.toThrow('disposed')
})
