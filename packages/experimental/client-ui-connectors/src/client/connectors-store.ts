/** Each official connector's installation state for the Connectors tab, read and switched through the Host plugin manager. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { BundleInfo } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { CONNECTORS } from './connectors.ts'

/** Whether the profile holds a connector's bundle, and whether it is switched on. */
export type ConnectorStatus = 'missing' | 'installed' | 'enabled'

/** The tab's state; connectors are keyed by package name once a read succeeded. */
export interface ConnectorsState {
  readonly status: 'idle' | 'loading' | 'ready' | 'error'
  readonly connectors: Readonly<Record<string, ConnectorStatus>>
  /** Package names of the connectors whose switch is being written or read back. */
  readonly busy: readonly string[]
  /** Package name of the connector whose latest switch the Host did not apply; null once another switch starts. */
  readonly failed: string | null
}

/** The face the tab's slot entry injects. */
export interface ConnectorsFace {
  /** Tab state, bound by the renderer as useConnectors. */
  hooks: { connectors: SnapshotStore<ConnectorsState> }
  /** DSH release the install buttons ask for; undefined in a build that carries none. */
  version: string | undefined
  /** Read the states unless a read already ran. */
  ensure: () => void
  /** Read the states again. */
  retry: () => void
  /** Switch an installed connector's bundle on or off, then read the states again. */
  setEnabled: (packageName: string, enabled: boolean) => void
}

/**
 * Reads the connectors' states through `pluginManager.listBundles`, where only the latest read publishes, and switches
 * a connector's bundle through `pluginManager.setBundleEnabled`.
 */
export class ConnectorsController {
  /** Tab state published to the tab. */
  readonly store: SnapshotStore<ConnectorsState> = createSnapshotStore<ConnectorsState>({
    status: 'idle', connectors: {}, busy: [], failed: null,
  })
  private read = 0
  private disposed = false

  /** @param ctx - the plugin context whose `remote.pluginManager` namespace answers. */
  constructor(private readonly ctx: ClientContext) {}

  /** Stop publishing late settlements. */
  dispose(): void {
    this.disposed = true
  }

  /**
   * Build the tab's injected face.
   * @param version - the DSH release the install buttons ask for.
   * @returns the tab's state source and actions.
   */
  face(version: string | undefined): ConnectorsFace {
    return {
      hooks: { connectors: this.store },
      version,
      ensure: () => { if (this.store.getSnapshot().status === 'idle') void this.load() },
      retry: () => { void this.load() },
      setEnabled: (packageName, enabled) => { void this.setEnabled(packageName, enabled) },
    }
  }

  /** Read the states again after the profile's bundles changed, once the tab has asked for them. */
  changed(): void {
    if (this.store.getSnapshot().status !== 'idle') void this.load()
  }

  private async load(): Promise<void> {
    const read = ++this.read
    // A ready list stays visible while a later read runs.
    if (this.store.getSnapshot().status !== 'ready') this.patch({ status: 'loading' })
    const answer = await this.ctx.remote.pluginManager.listBundles()
    if (this.disposed || read !== this.read) return
    if (!answer.ok) {
      this.patch({ status: 'error' })
      return
    }
    const bundles = new Map(answer.value.map(bundle => [bundle.name, bundle]))
    this.patch({
      status: 'ready',
      connectors: Object.fromEntries(CONNECTORS.map(connector => [connector.packageName, statusOf(bundles.get(connector.packageName))])),
    })
  }

  /** A connector stays busy through the read that follows its write, while its switch still shows the earlier state. */
  private async setEnabled(packageName: string, enabled: boolean): Promise<void> {
    this.patch({ busy: [...this.store.getSnapshot().busy, packageName], failed: null })
    const answer = await this.ctx.remote.pluginManager.setBundleEnabled(packageName, enabled)
    if (this.disposed) return
    if (!answer.ok || answer.value.application === 'failed') this.patch({ failed: packageName })
    await this.load()
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- dispose() can run during the await.
    if (this.disposed) return
    this.patch({ busy: this.store.getSnapshot().busy.filter(name => name !== packageName) })
  }

  private patch(change: Partial<ConnectorsState>): void {
    this.store.set({ ...this.store.getSnapshot(), ...change })
  }
}

function statusOf(bundle: BundleInfo | undefined): ConnectorStatus {
  if (bundle?.installed !== true) return 'missing'
  return bundle.enabled ? 'enabled' : 'installed'
}
