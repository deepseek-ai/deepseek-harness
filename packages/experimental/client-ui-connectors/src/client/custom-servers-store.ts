/** The custom servers section's state: the servers the `connectors` Remote lists, its changes' outcomes, and the probes. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { CustomServerView } from '../types.ts'
import type { ServerDraft } from '../server-form.ts'

/** One server of the manager's Settings namespace. */
export type CustomServer = CustomServerView

/** The latest probe of one server. */
export type ProbeState =
  | { readonly status: 'running' }
  | { readonly status: 'passed'; readonly tools: number; readonly truncated: boolean }
  | { readonly status: 'failed'; readonly message: string }

/** A change the Host refused; `conflict` means Settings changed elsewhere since the last read. */
export interface CustomServersFailure {
  readonly kind: 'conflict' | 'refused'
  readonly message: string
}

/** Everything the section shows. */
export interface CustomServersState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error' | 'unavailable'
  readonly writable: boolean
  readonly revision: number
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
  save: (draft: ServerDraft) => Promise<boolean>
  remove: (name: string) => void
  setEnabled: (name: string, enabled: boolean) => void
  probe: (name: string) => void
  dismissFailure: () => void
}

const INITIAL: CustomServersState = {
  status: 'idle', writable: false, revision: 0, servers: [], saving: false, failure: undefined, probes: {},
}

/**
 * Reads the servers through the `connectors` Remote when the section first asks, and sends each change to the Host as one
 * call: the Host stores the secrets, signs an OAuth grant out, writes the entry, and deletes the secrets it stopped
 * using. A refused change is reported; a conflicting one is also read again.
 */
export class CustomServersController {
  /** The section's state. */
  readonly store: SnapshotStore<CustomServersState> = createSnapshotStore<CustomServersState>(INITIAL)
  private read = 0
  private disposed = false
  private readonly probing = new Map<string, AbortController>()

  /** @param ctx - the browser context with the `connectors` and manager Remotes. */
  constructor(private readonly ctx: ClientContext) {}

  /** Cancel running probes; answers that arrive later change nothing. */
  dispose(): void {
    this.disposed = true
    for (const controller of this.probing.values()) controller.abort()
  }

  /**
   * Bind the section's actions.
   * @returns the face the section injects.
   */
  face(): CustomServersFace {
    return {
      hooks: { customServers: this.store },
      ensure: () => { if (this.state().status === 'idle') void this.load() },
      retry: () => { void this.load() },
      save: draft => this.save(draft),
      remove: (name) => { void this.change(() => this.ctx.remote.connectors.removeServer(name, this.state().revision)) },
      setEnabled: (name, enabled) => {
        void this.change(() => this.ctx.remote.connectors.setServerEnabled(name, enabled, this.state().revision))
      },
      probe: (name) => { void this.probe(name) },
      dismissFailure: () => { this.patch({ failure: undefined }) },
    }
  }

  /** Read again after a Settings document changed, once the section has read; the Host owns which namespace it lists. */
  changed(): void {
    if (this.state().status !== 'idle') void this.load()
  }

  private state(): CustomServersState {
    return this.store.getSnapshot()
  }

  private async load(): Promise<void> {
    const read = ++this.read
    if (this.state().status !== 'ready') this.patch({ status: 'loading' })
    const answer = await this.ctx.remote.connectors.listServers()
    if (this.disposed || read !== this.read) return
    if (!answer.ok) {
      this.patch({ status: 'error' })
      return
    }
    const list = answer.value
    this.patch(list.available
      ? { status: 'ready', writable: list.writable, revision: list.revision, servers: list.servers }
      : { status: 'unavailable', servers: [] })
  }

  private async save(draft: ServerDraft): Promise<boolean> {
    this.patch({ saving: true, failure: undefined })
    try {
      return await this.change(() => this.ctx.remote.connectors.saveServer(draft, this.state().revision))
    } finally {
      this.patch({ saving: false })
    }
  }

  /** Send one change, then read again; report a refusal, and read again after a conflict. */
  private async change(call: () => Promise<RemoteResult<void>>): Promise<boolean> {
    const answer = await call()
    if (this.disposed) return false
    if (answer.ok) {
      void this.load()
      return true
    }
    const conflict = answer.error.code === 'connectors/conflict'
    this.patch({ failure: { kind: conflict ? 'conflict' : 'refused', message: answer.error.message } })
    if (conflict) void this.load()
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
