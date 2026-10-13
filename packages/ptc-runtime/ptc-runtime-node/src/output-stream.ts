/** Bounded drainage for raw process output after managed execution ends. */
import type { Readable } from 'node:stream'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'

/**
 * Wait for queued bytes without letting an inherited descriptor retain a run forever.
 * @param stream - Caller-owned raw process output, when provided.
 * @param graceMs - Maximum wait after managed process termination.
 * @returns Whether the complete stream ended without a transport error.
 */
export function drainOutput(stream: Readable | undefined, graceMs: number): Promise<boolean> {
  if (stream === undefined || stream.readableEnded) return Promise.resolve(true)
  if (stream.destroyed) return Promise.resolve(false)
  return new Promise((resolve) => {
    const finish = (complete: boolean): void => {
      clearTimeout(timer)
      stream.off('end', onEnd)
      stream.off('close', onClose)
      stream.off('error', onError)
      resolve(complete)
    }
    const onEnd = (): void => { finish(true) }
    const onClose = (): void => { finish(false) }
    const onError = (): void => { finish(false) }
    const timer = setTimeout(() => { finish(false) }, graceMs)
    stream.once('end', onEnd)
    stream.once('close', onClose)
    stream.once('error', onError)
  })
}

/**
 * Terminate a managed process and drain its pipes, including failures before output listeners attach.
 * @param handle - Process and streams owned by the runtime.
 * @param graceMs - Maximum pipe-drain wait after managed exit.
 * @returns Whether both output streams ended cleanly.
 */
export async function terminateProcess(handle: SubprocessHandle, graceMs: number): Promise<boolean> {
  try {
    handle.terminate()
    handle.stdout?.resume()
    handle.stderr?.resume()
    await Promise.all([handle.done.catch(() => {}), handle.waitForExit()])
    const drained = await Promise.all([drainOutput(handle.stdout, graceMs), drainOutput(handle.stderr, graceMs)])
    return !drained.includes(false)
  } finally {
    handle.stdout?.destroy()
    handle.stderr?.destroy()
  }
}
