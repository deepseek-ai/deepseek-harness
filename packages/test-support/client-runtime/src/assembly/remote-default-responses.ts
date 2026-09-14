/**
 * Default responses for every Remote endpoint the web assembly calls while
 * booting and rendering with no sessions, no workspaces, and default settings.
 * The comment above each row names the plugin that calls it; endpoints boot
 * never touches stay absent so a new call fails loud. `$events` is built into
 * `RemoteMock`.
 * @module @deepseek-ai/dsh-client-test-runtime/src/assembly/remote-default-responses
 */
import { ok, openStream, type RemoteTable } from '@deepseek-ai/dsh-remote-mock'

/** Default responses of the boot-time Remote endpoints; a spec loads it first and layers its own table on top. */
export const remoteDefaultResponses: RemoteTable = {
  unary: {
    // api-session-controller `sessions.handleConnected()` on `connection/reset`.
    'session/list': ok({ items: [] }),
    // ui-settings `mirror.ensure()` at apply and again on `connection/reset`.
    'settings/describe': ok({ writable: true, hasDocument: false, namespaces: [] }),
    // ui-model-selection `ModelDirectoryResolver` constructor.
    'session/modelCatalog': ok({
      default: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      routableProviders: [],
      groups: [],
      failures: [],
    }),
    // ui-agent-preset hero chip and header label on first mount.
    'agentPresets/list': ok({ presets: [], authorable: false }),
    // cordis-client-runner `ClientCordisInspectRegistry.sync` at apply and on `connection/reset`.
    'dynamicCordisRunner/syncInspectManifest': ok(null),
    // ui-cordis inventory at apply and on `connection/reset`.
    'dynamicCordisRunner/inventory': ok([]),
    // ui-settings-plugins web-search card `readCredential()` when the settings mirror first publishes.
    'credentials/describe': ok({}),
    // ui-permission-presets `PermissionCatalogDirectory` on its first read for a connection generation.
    'permissionPresets/catalog': ok({ options: [] }),
  },
  // Stream endpoints the roster opens later than boot; declared so a spec that forgets the script gets a stream miss.
  streams: [
    // api-session-controller `SessionEventStream.follow` when a Session opens.
    'session/follow',
  ],
  stream: {
    // api-session-controller client `apply`: the control stream's opening baseline, then open.
    'session/control': openStream([{ type: 'baseline', value: { queues: {}, jobs: {}, projections: {} } }]),
    // api-workspace-controller client `apply`: the follow stream's opening baseline, then open.
    'workspace/follow': openStream([{ type: 'baseline', value: { items: [], archivedSessionIds: [] } }]),
  },
}
