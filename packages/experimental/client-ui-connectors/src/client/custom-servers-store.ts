/** The custom servers section's state: the server rows the `connectors` Remote streams, its changes' outcomes, and the probes. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { RemoteStream } from '@deepseek-ai/dsh-api-gateway/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CustomServersList, CustomServerView } from '../types.ts'
import type { ServerDraft } from '../server-form.ts'

/** One MCP server row of the profile's composition. */
export type CustomServer = CustomServerView

/** The latest probe of one server. */
export type ProbeState =
  | { readonly status: 'running' }
  | { readonly status: 'passed'; readonly tools: number; readonly truncated: boolean }
  | { readonly status: 'failed'; readonly message: string }

/** A change the Host refused; `conflict` means the server rows changed elsewhere since the list arrived. */
export interface CustomServersFailure {
  readonly kind: 'conflict' | 'refused'
  readonly message: string
}

/** Everything the section shows. */
export interface CustomServersState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'
  readonly revision: string
  readonly servers: readonly CustomServer[]
  readonly saving: boolean
  readonly failure: CustomServersFailure | undefined
  readonly probes: Readonly<Record<string, ProbeState>>
}

/** The face the section injects; every action runs without awaiting except `save`, which reports success. */
export interface CustomServersFace {
  hooks: { customServers: SnapshotStore<CustomServersState> }
  ensure: () => void
  retry: () => void
  /** Save a new server, or the server row `id` names. */
  save: (draft: ServerDraft, id?: string) => Promise<boolean>
  remove: (id: string) => void
  setEnabled: (id: string, enabled: boolean) => void
  /** Probe the server registered under `name`. */
  probe: (name: string) => void
  dismissFailure: () => void
}

const INITIAL: CustomServersState = {
  status: 'idle', revision: '', servers: [], saving: false, failure: undefined, probes: {},
}

/**
 * Follows the server rows through the `connectors` Remote's stream once the section first asks, and sends each change
 * to the Host as one call that names the revision of the list it was made on. The Host sends the list again after
 * every change of the rows, so a successful change shows without a separate read. A refused change is reported; a
 * conflicting one also reopens the stream. A stream that fails stays closed until `retry`.
 */
export class CustomServersController {
  /** The section's state. */
  readonly store: SnapshotStore<CustomServersState> = createSnapshotStore<CustomServersState>(INITIAL)
  private stream: RemoteStream<CustomServersList> | undefined
  private following: Promise<void> | undefined
  private disposed = false
  private readonly probing = new Map<string, AbortController>()

  /** @param ctx - the browser context with the `connectors` and manager Remotes. */
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Cancel running probes and close the stream; a change or probe the Host answers later reports nothing.
   * @returns once the stream's consumer has stopped.
   */
  async dispose(): Promise<void> {
    this.disposed = true
    for (const controller of this.probing.values()) controller.abort()
    await this.stream?.dispose()
    await this.following
  }

  /**
   * Bind the section's actions.
   * @returns the face the section injects.
   */
  face(): CustomServersFace {
    return {
      hooks: { customServers: this.store },
      ensure: () => { if (this.state().status === 'idle') this.follow() },
      retry: () => { if (this.state().status === 'error') this.follow() },
      save: (draft, id) => this.save(draft, id),
      remove: (id) => { void this.change(() => this.ctx.remote.connectors.removeServer(id, this.state().revision)) },
      setEnabled: (id, enabled) => {
        void this.change(() => this.ctx.remote.connectors.setServerEnabled(id, enabled, this.state().revision))
      },
      probe: (name) => { void this.probe(name) },
      dismissFailure: () => { this.patch({ failure: undefined }) },
    }
  }

  private state(): CustomServersState {
    return this.store.getSnapshot()
  }

  /** Open a stream and show each list it delivers; a stream that failed cannot be consumed again, so `retry` opens another. */
  private follow(): void {
    const stream = this.ctx.remote.$stream<CustomServersList>({
      name: 'Custom MCP servers',
      open: signal => this.ctx.remote.connectors.watchServers(signal),
      ended: () => new Error('Custom MCP servers stream ended'),
    })
    this.stream = stream
    this.patch({ status: 'loading' })
    this.following = this.observe(stream)
  }

  private async observe(stream: RemoteStream<CustomServersList>): Promise<void> {
    try {
      for await (const item of stream) {
        const list = item.value
        this.patch(list.available
          ? { status: 'ready', revision: list.revision, servers: list.servers }
          : { status: 'unavailable', revision: '', servers: [] })
        item.accept()
      }
    } catch (error) {
      // Disposal ends the stream without an error, so every caught failure is a live stream failure.
      this.patch({ status: 'error' })
      this.ctx.logger.warn('custom MCP servers stream failed: %s', error)
    }
  }

  private async save(draft: ServerDraft, id: string | undefined): Promise<boolean> {
    this.patch({ saving: true, failure: undefined })
    try {
      return await this.change(() => this.ctx.remote.connectors.saveServer(draft, this.state().revision, id))
    } finally {
      this.patch({ saving: false })
    }
  }

  /** Send one change and report a refusal. A conflict means this list missed a change, so the stream reopens and reads it again. */
  private async change(call: () => Promise<RemoteResult<void>>): Promise<boolean> {
    const answer = await call()
    if (this.disposed) return false
    if (answer.ok) return true
    const conflict = answer.error.code === 'connectors/conflict'
    this.patch({ failure: { kind: conflict ? 'conflict' : 'refused', message: answer.error.message } })
    if (conflict) this.stream?.restart()
    return false
  }

  private async probe(name: string): Promise<void> {
    this.probing.get(name)?.abort()
    const controller = new AbortController()
    this.probing.set(name, controller)
    this.patchProbe(name, { status: 'running' })
    const answer = await this.ctx.remote.mcpManager.probe(name, controller.signal)
    if (this.disposed || this.probing.get(name) !== controller) return
    this.probing.delete(name)
    if (!answer.ok) {
      this.patchProbe(name, { status: 'failed', message: answer.error.message })
      return
    }
    const result = answer.value
    this.patchProbe(name, result.ok
      ? { status: 'passed', tools: result.toolNames.length, truncated: result.truncated }
      : { status: 'failed', message: result.message })
  }

  private patchProbe(name: string, probe: ProbeState): void {
    this.patch({ probes: { ...this.state().probes, [name]: probe } })
  }

  private patch(change: Partial<CustomServersState>): void {
    this.store.set({ ...this.state(), ...change })
  }
}
