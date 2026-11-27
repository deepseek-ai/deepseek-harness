/** Mounted-only polling for the owner's pending pairing requests. */
import type { Context } from '@deepseek-ai/cordis'
import type { ResourceProvider } from '@deepseek-ai/dsh-client-resources/client'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { PairingRequestId, PairingRequestsValue } from '../types.ts'
import type {} from '@deepseek-ai/dsh-client-remote-connection/remote'

declare module '@deepseek-ai/dsh-client-ui-slots/client' {
  interface ResourceProtocolMap {
    /** Pairing requests whose displayed codes require owner approval. */
    'device-pairing': PairingRequestsValue
  }
}

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** The approval-list read failed before a response was received. */
    'pairing/read-failed': {}
  }
}

/**
 * Poll held request lists and remove confirmed decisions from live lists before their next read.
 * Failed reads wait for a confirmation or a newly opened retry and recover on a successful read.
 * @param remote - generated pairing Remote methods.
 * @returns the provider and a callback that waits for live lists to consume the removal or close.
 */
export function requestsResource(remote: Pick<Context['remote']['remoteConnection'], 'pairingRequests'>): {
  provider: ResourceProvider<'device-pairing'>
  confirmed(id: PairingRequestId): Promise<void>
} {
  const active = new Set<(id: PairingRequestId) => Promise<void>>()
  const provider: ResourceProvider<'device-pairing'> = {
    protocol: 'device-pairing',
    async *open(_address, { signal }) {
      const aborted = (): boolean => signal.aborted
      if (aborted()) return
      let current: PairingRequestsValue | undefined
      let request: AbortController | undefined
      let timer: ReturnType<typeof setTimeout> | undefined
      let wake = Promise.withResolvers<undefined>()
      const pending = new Set<PairingRequestId>()
      const acknowledgements = new Set<() => void>()
      const acknowledge = (callbacks: readonly (() => void)[]): void => {
        for (const callback of callbacks) {
          acknowledgements.delete(callback)
          callback()
        }
      }
      const confirmed = (id: PairingRequestId): Promise<void> => new Promise<void>((resolve) => {
        pending.add(id)
        acknowledgements.add(resolve)
        request?.abort()
        clearTimeout(timer)
        wake.resolve(undefined)
      })
      const close = (): void => {
        active.delete(confirmed)
        signal.removeEventListener('abort', close)
        request?.abort()
        clearTimeout(timer)
        acknowledge([...acknowledgements])
        wake.resolve(undefined)
      }
      const read = async (readSignal: AbortSignal): Promise<RemoteResult<PairingRequestsValue>> => {
        try {
          return await remote.pairingRequests(readSignal)
        } catch (error) {
          return {
            ok: false,
            error: remoteErrorOf(error) ?? new RemoteError('pairing/read-failed', `Could not read pairing requests: ${String(error)}`, {}),
          }
        }
      }
      active.add(confirmed)
      signal.addEventListener('abort', close, { once: true })
      try {
        while (!aborted()) {
          if (pending.size > 0) {
            if (current !== undefined) {
              current = { ...current, requests: current.requests.filter(row => !pending.has(row.id)) }
              pending.clear()
              const consumed = [...acknowledgements]
              yield { ok: true, value: current }
              if (aborted()) return
              acknowledge(consumed)
              continue
            }
            pending.clear()
            acknowledge([...acknowledgements])
          }
          wake = Promise.withResolvers<undefined>()
          request = new AbortController()
          const result = await Promise.race([read(request.signal), wake.promise.then(() => undefined)])
          request = undefined
          if (aborted()) return
          // A confirmed decision supersedes any read already in flight, even if its transport ignores abort.
          if (pending.size > 0 || result === undefined) continue
          current = result.ok ? result.value : undefined
          const consumed = [...acknowledgements]
          yield result
          acknowledge(consumed)
          if (pending.size > 0) continue
          if (aborted()) return
          if (result.ok) timer = setTimeout(() => { wake.resolve(undefined) }, result.value.pollIntervalMs)
          await wake.promise
          clearTimeout(timer)
        }
      } finally {
        close()
      }
    },
  }
  return {
    provider,
    async confirmed(id) { await Promise.all([...active].map(notify => notify(id))) },
  }
}
