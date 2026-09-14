/**
 * `ctx.resources`: the provider registry and the per-address states behind
 * `useResource`.
 *
 * A record is kept for every address ever sourced and is never dropped; what
 * the last release discards is its state (the stream is aborted and the
 * snapshot returns to idle). Keeping the record keeps `source()` reference-stable
 * across React's render-then-subscribe window and a StrictMode remount, where a
 * recreated record would make every render resubscribe and restart the stream.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type {
  ResourceOpenContext,
  ResourceProtocol,
  ResourceProvider,
  Resources,
  ResourceSnapshot,
} from './contract.ts'

/** A provider with its value type erased, so one map holds every protocol. */
interface RuntimeProvider {
  readonly protocol: string
  open(address: string, ctx: ResourceOpenContext): AsyncIterable<RemoteResult<unknown>>
}

/** One address: its state, its holders, and the running stream. */
interface ResourceRecord {
  readonly address: string
  /** The address's protocol key (`dsh-resource://` host); absent when the address is not a resource address. */
  readonly protocol: string | undefined
  readonly store: SnapshotStore<ResourceSnapshot<unknown>>
  readonly source: ObservableSnapshot<ResourceSnapshot<unknown>>
  /** Subscribers plus pins; the stream runs while this is positive. */
  holders: number
  /** Present while the provider's stream runs; aborting it ends the stream. */
  controller: AbortController | undefined
}

/**
 * The one URL scheme resource addresses use: `dsh-resource://<type>/…`, where
 * the host names the protocol. Other schemes (`sidebar://…`) are navigation
 * addresses and name no resource.
 */
export const RESOURCE_SCHEME = 'dsh-resource'

/**
 * The protocol key of one address: the host of a `dsh-resource://` URL, as the
 * URL parser reads it (lower-cased). Any other string — another scheme, or one
 * the URL parser rejects — names no protocol and is treated like an address
 * whose protocol has no provider.
 * @param address - the full address.
 * @returns the protocol key, or `undefined` when the address is not a resource address.
 */
export function protocolOf(address: string): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(address)
  } catch {
    // The URL parser rejects strings without a scheme (`/a/b.txt`, `''`);
    // nothing else throws here, and an unparseable address is simply not ours.
    return undefined
  }
  if (parsed.protocol !== `${RESOURCE_SCHEME}:`) return undefined
  // A non-special scheme's host is opaque to the URL parser and keeps its case.
  return parsed.hostname === '' ? undefined : parsed.hostname.toLowerCase()
}

function idle(status: 'none' | 'loading'): ResourceSnapshot<unknown> {
  return { status, value: undefined, failure: undefined }
}

/** The `ctx.resources` implementation. */
export class ResourceRegistry implements Resources {
  private readonly providers = new Map<string, RuntimeProvider>()
  private readonly records = new Map<string, ResourceRecord>()

  /** @param ctx - Context whose effects own the registered providers. */
  constructor(private readonly ctx: Context) {}

  register<P extends ResourceProtocol>(provider: ResourceProvider<P>): () => void {
    const runtime: RuntimeProvider = provider
    const { protocol } = runtime
    if (this.providers.has(protocol)) {
      throw new Error(`resources: protocol "${protocol}" already has a provider`)
    }
    const dispose = this.ctx.effect(() => {
      this.providers.set(protocol, runtime)
      for (const record of this.recordsOf(protocol)) this.attach(record)
      return () => {
        this.providers.delete(protocol)
        for (const record of this.recordsOf(protocol)) this.detach(record)
      }
    }, `resources.register(${JSON.stringify(protocol)})`)
    return () => { void dispose() }
  }

  pin(address: string, signal: AbortSignal): void {
    if (signal.aborted) return
    const record = this.record(address)
    this.hold(record)
    signal.addEventListener('abort', () => { this.release(record) }, { once: true })
  }

  source(address: string): ObservableSnapshot<ResourceSnapshot<unknown>> {
    return this.record(address).source
  }

  private record(address: string): ResourceRecord {
    let record = this.records.get(address)
    if (record === undefined) {
      record = this.create(address)
      this.records.set(address, record)
    }
    return record
  }

  private create(address: string): ResourceRecord {
    const protocol = protocolOf(address)
    const store = createSnapshotStore<ResourceSnapshot<unknown>>(
      idle(this.providerOf(protocol) === undefined ? 'none' : 'loading'),
    )
    const record: ResourceRecord = {
      address,
      protocol,
      store,
      holders: 0,
      controller: undefined,
      source: {
        getSnapshot: () => store.getSnapshot(),
        subscribe: (listener) => {
          const unsubscribe = store.subscribe(listener)
          this.hold(record)
          let active = true
          return () => {
            if (!active) return
            active = false
            unsubscribe()
            this.release(record)
          }
        },
      },
    }
    return record
  }

  private providerOf(protocol: string | undefined): RuntimeProvider | undefined {
    return protocol === undefined ? undefined : this.providers.get(protocol)
  }

  private *recordsOf(protocol: string): Iterable<ResourceRecord> {
    for (const record of this.records.values()) {
      if (record.protocol === protocol) yield record
    }
  }

  private hold(record: ResourceRecord): void {
    record.holders += 1
    if (record.holders === 1) this.start(record)
  }

  private release(record: ResourceRecord): void {
    record.holders -= 1
    if (record.holders > 0) return
    this.stop(record)
    record.store.set(idle(this.providerOf(record.protocol) === undefined ? 'none' : 'loading'))
  }

  /** The provider arrived: a held record opens its stream, an idle one turns `loading`. */
  private attach(record: ResourceRecord): void {
    if (record.holders > 0) {
      this.start(record)
      return
    }
    record.store.set(idle('loading'))
  }

  /** The provider left: the stream ends and the record reports `none`. */
  private detach(record: ResourceRecord): void {
    this.stop(record)
    record.store.set(idle('none'))
  }

  private start(record: ResourceRecord): void {
    const provider = this.providerOf(record.protocol)
    if (provider === undefined) return
    const controller = new AbortController()
    record.controller = controller
    if (record.store.getSnapshot().status !== 'loading') record.store.set(idle('loading'))
    void this.consume(record, provider, controller.signal)
  }

  private stop(record: ResourceRecord): void {
    record.controller?.abort()
    record.controller = undefined
  }

  /** Failures arrive as frames; a throw inside the stream is left to surface. */
  private async consume(record: ResourceRecord, provider: RuntimeProvider, signal: AbortSignal): Promise<void> {
    const stream = provider.open(record.address, { signal })
    for await (const frame of stream) {
      // A frame the provider yields after the release that aborted it belongs
      // to nobody; ending the loop also returns the iterator.
      if (signal.aborted) break
      record.store.set(frame.ok
        ? { status: 'live', value: frame.value, failure: undefined }
        : { status: 'failed', value: record.store.getSnapshot().value, failure: frame.error })
    }
  }
}
