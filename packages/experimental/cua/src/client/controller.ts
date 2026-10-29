/** One query projection for the permission page and activation guidance. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-cua/remote'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type { ApplicationDragReference } from '@deepseek-ai/dsh-util-file-drag'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { CuaApplicationId, CuaApplicationState, CuaSystemPermission, CuaSystemPermissionState } from '../access-types.ts'

interface PermissionData {
  runtime: { persistent: boolean; writable: boolean }
  system: CuaSystemPermissionState
  applications: CuaApplicationState
  icons: Record<string, string>
}
/** Query failures retain the last observation without presenting it as current. */
interface Query<T> {
  value: T | null
  busy: boolean
  error: string | null
}
/** Independently settled observations; the overall busy flag follows the latest refresh. */
export type PermissionView = { [K in keyof PermissionData]: Query<PermissionData[K]> } & {
  busy: boolean
  changing: boolean
  guidance: CuaSystemPermission | null
  toast: { id: number; kind: 'requested' | 'opened' | 'revealed' | 'revoked' | 'retryAllowed' } | { id: number; kind: 'failed'; message: string } | null
}
/** Slot actions and the renderer-bound permission projection. */
export interface PermissionFace {
  hooks: { cuaPermissions: SnapshotStore<PermissionView> }
  refresh: () => void
  request: (permission: CuaSystemPermission) => void
  openSettings: (permission: CuaSystemPermission) => void
  revealApplication: (reference: ApplicationDragReference) => void
  closeGuidance: () => void
  revoke: (id: CuaApplicationId) => void
  retryApproval: (id: CuaApplicationId) => void
  dismissToast: () => void
}

/** Serializes actions, pauses reads during management operations, and drops superseded or disposed results. */
export class PermissionController {
  /** Last observed permissions and the lifetime of the current refresh/action. */
  readonly state = createSnapshotStore<PermissionView>({
    runtime: { value: null, busy: false, error: null },
    system: { value: null, busy: false, error: null },
    applications: { value: null, busy: false, error: null },
    icons: { value: null, busy: false, error: null },
    busy: false, changing: false, guidance: null, toast: null,
  })
  private tail: Promise<void> = Promise.resolve()
  private reads: Promise<void> = Promise.resolve()
  private closed = false
  private epoch = 0
  private sequence = 0
  private systemSequence = 0
  private pollingStarted = 0
  private pollTimer: ReturnType<typeof setTimeout> | undefined
  /** @param remote Generated CUA Remote namespace; failed results are handled with query and action failures. */
  constructor(private readonly remote: Context['remote']['cuaAccess']) {}
  /**
   * Bind the permission projection to its user actions.
   * @returns Reactive state and controls shared by the page, prompt, and toast host.
   */
  face(): PermissionFace {
    return {
      hooks: { cuaPermissions: this.state },
      refresh: () => { this.enqueue() },
      request: (permission) => {
        if (this.closed || this.state.getSnapshot().changing) return
        this.stopPolling()
        this.pollingStarted = performance.now()
        this.state.update((state) => { state.guidance = permission })
        this.enqueue(() => this.remote.requestPermission(permission), 'requested')
      },
      openSettings: (permission) => { this.enqueue(() => this.remote.openSettings(permission), 'opened') },
      revealApplication: (reference) => { this.enqueue(() => this.remote.revealApplication(reference), 'revealed') },
      closeGuidance: () => {
        this.stopPolling()
        if (!this.closed) this.state.update((state) => { state.guidance = null })
      },
      revoke: (id) => { this.enqueue(() => this.remote.revoke(id), 'revoked') },
      retryApproval: (id) => { this.enqueue(() => this.remote.retryApproval(id), 'retryAllowed') },
      dismissToast: () => { if (!this.closed) this.state.update((state) => { state.toast = null }) },
    }
  }
  /**
   * Update query admission from the management operation's synchronous notification.
   * @param changing Whether a bundle or row operation is pending; settlement refreshes observations.
   */
  setChanging(changing: boolean): void {
    if (this.closed || changing === this.state.getSnapshot().changing) return
    this.epoch++
    this.stopPolling()
    this.state.update((state) => {
      state.changing = changing
      state.busy = true
      for (const key of ['runtime', 'system', 'applications', 'icons'] as const) state[key].busy = true
    })
    if (!changing) this.enqueue()
  }
  /** Prevent publication after UI withdrawal and join the accepted Remote work. */
  async dispose(): Promise<void> { this.closed = true; this.stopPolling(); await this.tail; await this.reads }

  private stopPolling(): void {
    clearTimeout(this.pollTimer)
    this.pollTimer = undefined
  }

  private schedulePoll(): void {
    this.stopPolling()
    const state = this.state.getSnapshot()
    const permission = state.guidance
    if (this.closed || state.changing || permission === null || state.system.error !== null || state.system.value === null) return
    if (state.system.value[permission]) {
      this.state.update((state) => { state.guidance = null })
      return
    }
    const { intervalMs, timeoutMs } = state.system.value.guidancePolling
    if (performance.now() - this.pollingStarted + intervalMs > timeoutMs) return
    const epoch = this.epoch
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined
      const current = () => !this.closed && epoch === this.epoch && this.state.getSnapshot().guidance === permission
      const read = this.read('system', this.remote.systemStatus, current)
      this.reads = Promise.all([this.reads, read]).then(() => {})
    }, intervalMs)
  }

  private enqueue(action?: () => Promise<RemoteResult<unknown>>, kind?: 'requested' | 'opened' | 'revealed' | 'revoked' | 'retryAllowed'): void {
    if (this.closed || this.state.getSnapshot().changing) return
    this.stopPolling()
    this.systemSequence++
    const epoch = this.epoch
    const current = () => !this.closed && epoch === this.epoch
    const sequence = ++this.sequence
    this.state.update((state) => {
      state.busy = true
      for (const key of ['runtime', 'system', 'applications', 'icons'] as const) state[key].busy = true
    })
    this.tail = this.tail.then(async () => {
      if (!current()) return
      try {
        if (action) {
          const result = await action()
          if (!result.ok) throw result.error
        }
        if (!current()) return
        if (kind) this.state.update((state) => { state.toast = { id: sequence, kind } })
      } catch (error) {
        if (!current()) return
        const message = error instanceof Error ? error.message : String(error)
        this.state.update((state) => { state.toast = { id: sequence, kind: 'failed', message } })
      }
      const latest = () => current() && this.sequence === sequence
      const refresh = Promise.all([
        this.read('runtime', this.remote.ptcConfiguration, latest),
        this.read('system', this.remote.systemStatus, latest),
        this.read('applications', this.remote.applications, latest),
        this.read('icons', this.remote.applicationIcons, latest),
      ]).then(() => {
        if (latest()) this.state.update((state) => { state.busy = false })
      })
      this.reads = Promise.all([this.reads, refresh]).then(() => {})
    })
  }

  private async read<K extends keyof PermissionData>(
    key: K, read: () => Promise<RemoteResult<PermissionData[K]>>, current: () => boolean,
  ): Promise<void> {
    if (!current()) return
    const sequence = key === 'system' ? ++this.systemSequence : this.systemSequence
    const latest = () => current() && (key !== 'system' || sequence === this.systemSequence)
    try {
      const result = await read()
      if (!latest()) return
      if (!result.ok) throw result.error
      this.state.update((state) => { state[key].value = result.value; state[key].error = null; state[key].busy = false })
    } catch (error) {
      if (!latest()) return
      this.state.update((state) => {
        state[key].error = error instanceof Error ? error.message : String(error); state[key].busy = false
      })
    }
    if (key === 'system' && latest()) this.schedulePoll()
  }
}
