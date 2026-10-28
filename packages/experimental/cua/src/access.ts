/** Browser controls for the provider's application decisions and native permission work. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-ptc-runtime'
import { resolvePersistentExecution } from '@deepseek-ai/dsh-ptc-runtime-node/configuration'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { ApplicationAccess, type AccessOptions } from './application-access.ts'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { ApplicationIcon } from './protocol.ts'
import { NativeClient, type NativeClientConfig, type NativeChannelFactory } from './native-client.ts'
import type { CuaApplicationId, CuaApplicationState, CuaSystemPermission, CuaSystemPermissionState } from './access-types.ts'
export { ApplicationAuthorizationResult } from './application-access.ts'
export type * from './access-types.ts'

interface ControlOptions extends AccessOptions {
  native: NativeClientConfig
  createChannel: NativeChannelFactory
}
type Control = (method: string, params: Record<string, JsonValue>) => Promise<JsonValue>
const permissionProcess = z.object({ pid: z.number().int().positive(), path: z.string().optional(), name: z.string().optional() })
const systemPermissions = z.object({
  accessibility: z.boolean(), screenRecording: z.boolean(), helper: permissionProcess, parent: permissionProcess,
  launchApplication: z.object({ name: z.string().min(1), path: z.string().min(1), icon: ApplicationIcon.optional() }).optional(),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Native permission controls and executor-owned application consent. */
    cuaAccess: CuaAccess
  }
}

/** Browser controls for provider-owned native permission and application decisions. */
export class CuaAccess extends TypertRemoteService {
  /**
   * @param ctx Provider context.
   * @param policy Application decision owner.
   * @param control Serialized native permission dispatch.
   */
  constructor(ctx: Context, private readonly policy: ApplicationAccess,
    private readonly control: Control) { super(ctx, 'cuaAccess') }

  /** Read PTC execution state separately from native permission checks.
   * @returns Whether the shared runtime retains memory and has an editable profile entry.
   */
  @Remote
  ptcConfiguration(): { persistent: boolean; writable: boolean } {
    const runtime = this.ctx.get('ptcRuntime')
    return {
      persistent: runtime?.retainsState === true,
      writable: this.ctx.get('configEditor')?.entries().some(entry => entry.options.id === 'ptc-runtime') ?? false,
    }
  }

  /** Persist in-memory PTC execution through the existing profile editor and Loader lifecycle.
   * @returns Completion after the shared runtime reload; already-persistent runtimes are left intact.
   */
  @Remote
  async enablePersistentPtc(): Promise<void> {
    if (this.ptcConfiguration().persistent) return
    const editor = this.ctx.get('configEditor')
    const entry = editor?.entries().find(entry => entry.options.id === 'ptc-runtime')
    if (editor === undefined || entry === undefined) throw new Error('PTC runtime has no editable profile entry')
    await editor.edit(entry, current => ({ ...current, ...resolvePersistentExecution(this.ctx.get('ptcRuntime')?.programFormat) }))
  }

  /**
   * Read fresh stored application decisions without issuing a native request.
   * @returns Saved grants, refused applications and durable-storage availability.
   */
  @Remote
  applications(): Promise<CuaApplicationState> { return this.policy.status() }

  /**
   * Inspect system privileges independently of application decisions and icons.
   * @returns Fresh native preflight and launch metadata.
   */
  @Remote
  async systemStatus(): Promise<CuaSystemPermissionState> {
    return systemPermissions.parse(await this.control('permissionStatus', {}))
  }

  /**
   * Load presentation icons separately from application decisions.
   * @returns Optional native PNG icons keyed by executable path; applications without paths are skipped.
   */
  @Remote
  async applicationIcons(): Promise<Record<string, string>> {
    const state = await this.policy.status()
    const paths = [...new Set([...state.allowedApps, ...state.blockedApps]
      .flatMap(app => app.executablePath === undefined ? [] : [app.executablePath]))]
    return paths.length === 0 ? {} : z.record(z.string(), ApplicationIcon).parse(await this.control('applicationIcons', { paths }))
  }

  /**
   * Request a system privilege explicitly selected by the user.
   * @param permission macOS privilege to request.
   * @returns Preflight state after requesting; a false value never implies consent.
   */
  @Remote
  async requestPermission(permission: CuaSystemPermission): Promise<CuaSystemPermissionState> {
    return systemPermissions.parse(await this.control('requestPermission', { permission }))
  }

  /**
   * Open the macOS privacy pane selected by the user.
   * @param permission Corresponding system privilege.
   * @returns Completion after macOS accepted the open request.
   */
  @Remote
  async openSettings(permission: CuaSystemPermission): Promise<void> {
    z.object({ opened: z.literal(true) }).parse(await this.control('openPermissionSettings', { permission }))
  }

  /**
   * Remove saved and session access and join affected operations.
   * @param id Application identity displayed on the permission page.
   * @returns Completion after persistence and cancellation; dispatched input cannot be undone.
   */
  @Remote
  revoke(id: CuaApplicationId): Promise<void> { return this.policy.revoke(id) }

  /**
   * Clear this application's refusals across sessions so each session may ask for access again.
   * @param id Refused or revoked application displayed on the permission page.
   * @returns Completion after clearing refusals; no permission is granted and no action is replayed.
   */
  @Remote
  async retryApproval(id: CuaApplicationId): Promise<void> { await this.policy.retryApproval(id) }
}

/**
 * Install human-facing controls while keeping executor capabilities private to the provider.
 * @param ctx Provider context that owns decisions and operation lifetimes.
 * @param options Native transport and profile persistence.
 * @returns Consent selection, guarded dispatch, and task cleanup capabilities.
 */
export function installCuaAccess(ctx: Context, options: ControlOptions): Pick<ApplicationAccess, 'select' | 'run' | 'forget' | 'dispose'> {
  const policy = new ApplicationAccess(ctx, options)
  const lifetime = new AbortController()
  let client: NativeClient | undefined
  let tail: Promise<unknown> = Promise.resolve()
  const control: Control = (method, params) => {
    lifetime.signal.throwIfAborted()
    const perform = async () => {
      lifetime.signal.throwIfAborted()
      if (client?.disposed) await client.dispose()
      lifetime.signal.throwIfAborted()
      if (!client || client.disposed) client = new NativeClient(ctx, options.native, options.createChannel)
      return client.request(method, params, lifetime.signal)
    }
    const operation = tail.then(perform, perform)
    tail = operation
    return operation
  }
  const dispose = ctx.effect(() => async () => {
    lifetime.abort()
    await Promise.allSettled([policy.dispose(), tail])
    await client?.dispose()
  }, 'cua-access.dispose')
  new CuaAccess(ctx, policy, control)
  return { select: policy.select.bind(policy), run: policy.run.bind(policy), forget: policy.forget.bind(policy), dispose }
}
