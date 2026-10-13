/** Host-owned check, connection, and sign-out of the CLI's default Feishu account. */

import { randomUUID } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import z from 'zod'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { parseJson, type FeishuCli } from './cli.ts'
import type { FeishuAccountState, FeishuAppId, FeishuOperationId, FeishuOperationResult, FeishuOperationState, FeishuState } from './types.ts'

const NotConfigured = z.object({ ok: z.literal(false), error: z.object({ subtype: z.literal('not_configured') }) })
const User = z.object({
  status: z.string(),
  available: z.boolean(),
  verified: z.boolean().optional(),
  userName: z.string().optional(),
  openId: z.string().optional(),
})
const Status = z.object({ appId: z.string().min(1), identities: z.object({ user: User }) })
const LoginLink = z.object({ event: z.literal('device_authorization'), verification_uri_complete: z.string() })
const LoginComplete = z.object({ event: z.literal('authorization_complete'), user_open_id: z.string().min(1), missing: z.array(z.string()) })
const CONFIG_LINK = /^\s*(https:\/\/\S+)\s*$/u
const SIGNED_OUT = new Set(['missing', 'not_configured', 'needs_refresh'])

/** Deadlines for the account commands. */
export interface FeishuAccountLimits {
  /** Deadline for a status check or sign-out. */
  commandTimeoutMs: number
  /** Deadline for app setup or sign-in, which wait for the user in the browser. */
  authorizationTimeoutMs: number
}

interface Check { account: FeishuAccountState; openId?: string | undefined }

class Operation {
  readonly id = brandString<FeishuOperationId>(randomUUID())
  readonly controller = new AbortController()
  phase: FeishuOperationState['phase'] = 'checking'
  authorizationUrl: string | undefined
  done: Promise<void> = Promise.resolve()

  constructor(readonly kind: FeishuOperationState['kind']) {}

  view(): FeishuOperationState {
    const link = this.authorizationUrl === undefined ? {} : { authorizationUrl: this.authorizationUrl }
    return { id: this.id, kind: this.kind, phase: this.phase, ...link }
  }
}

/** Runs at most one account operation at a time; subscribers observe it without owning it. */
export class FeishuAccount {
  private account: FeishuAccountState = { state: 'unchecked' }
  /** The user the last completed sign-in left without some requested permissions, and how many. */
  private ungranted: { readonly openId: string; readonly count: number } | undefined
  private active: Operation | undefined
  private result: FeishuOperationResult | undefined
  private readonly lifetime = new AbortController()

  constructor(
    private readonly cli: FeishuCli,
    private readonly limits: FeishuAccountLimits,
    private readonly changed: () => void,
  ) {}

  /**
   * Read the latest account observation, the active operation, and the last result.
   * @returns a view without credentials.
   */
  snapshot(): FeishuState {
    return {
      account: this.account,
      ...this.active === undefined ? {} : { operation: this.active.view() },
      ...this.result === undefined ? {} : { result: this.result },
    }
  }

  /**
   * Start one operation.
   * @param kind - the requested operation.
   * @returns the operation identity.
   * @throws while another operation runs, or after disposal.
   */
  start(kind: FeishuOperationState['kind']): FeishuOperationId {
    this.lifetime.signal.throwIfAborted()
    if (this.active !== undefined) throw new Error('feishu: another account operation is in progress')
    const operation = new Operation(kind)
    this.active = operation
    this.result = undefined
    operation.done = this.execute(operation)
    this.changed()
    return operation.id
  }

  /** Start a check unless an operation already runs or the account is being disposed. */
  refresh(): void {
    if (this.active === undefined && !this.lifetime.signal.aborted) this.start('check')
  }

  /**
   * Cancel only the named operation and wait for its process to exit.
   * @param id - operation identity; a stale id is ignored.
   * @returns after the operation settles.
   */
  async cancel(id: FeishuOperationId): Promise<void> {
    const operation = this.active
    if (operation?.id !== id) return
    this.interrupt(operation)
    await operation.done
  }

  /**
   * Refuse new work, cancel the active operation, and wait for it.
   * @returns after account work stops.
   */
  async dispose(): Promise<void> {
    this.lifetime.abort(new Error('feishu: plugin disposed'))
    const operation = this.active
    if (operation === undefined) return
    this.interrupt(operation)
    await operation.done
  }

  private interrupt(operation: Operation): void {
    operation.controller.abort(new Error('feishu: account operation cancelled'))
    operation.phase = 'cancelling'
    operation.authorizationUrl = undefined
    this.changed()
  }

  private async execute(operation: Operation): Promise<void> {
    let outcome: FeishuOperationResult['outcome'] = 'succeeded'
    try {
      await this.perform(operation, AbortSignal.any([operation.controller.signal, this.lifetime.signal]))
    } catch {
      // Native diagnostics stay on the Host; the view reports one retryable outcome.
      outcome = operation.controller.signal.aborted ? 'cancelled' : 'failed'
    } finally {
      this.active = undefined
      this.result = { id: operation.id, kind: operation.kind, outcome }
      this.changed()
    }
  }

  private async perform(operation: Operation, signal: AbortSignal): Promise<void> {
    switch (operation.kind) {
      case 'check':
        await this.check(signal)
        return
      case 'link-app': return this.linkApp(operation, signal)
      case 'sign-in': return this.signIn(operation, signal)
      case 'sign-out': {
        this.stage(operation, 'signing-out')
        const result = await this.cli.run(['auth', 'logout', '--json'], signal, { timeoutMs: this.limits.commandTimeoutMs })
        if (result.exitCode !== 0) throw new Error('feishu: auth logout failed')
        await this.check(signal)
        return
      }
      /* v8 ignore next -- closed operation kind union */
      default: return assertNever(operation.kind)
    }
  }

  /**
   * Link an app through the CLI's setup page; sign-in is a separate operation. An existing configuration,
   * including its sign-ins and any other app, is replaced by the app the user creates or chooses.
   */
  private async linkApp(operation: Operation, signal: AbortSignal): Promise<void> {
    this.stage(operation, 'configuring')
    const setup = await this.cli.run(['config', 'init', '--new'], signal, {
      timeoutMs: this.limits.authorizationTimeoutMs,
      onLine: (stream, line) => {
        const link = stream === 'stderr' && operation.authorizationUrl === undefined ? CONFIG_LINK.exec(line) : null
        if (link !== null) this.offer(operation, link[1] as string)
      },
    })
    if (setup.exitCode !== 0) throw new Error('feishu: config init failed')
    this.stage(operation, 'checking')
    if ((await this.check(signal)).account.state === 'unconfigured') throw new Error('feishu: config init left no app')
  }

  /** Sign the configured app's user in, then confirm the CLI's default account is that user. */
  private async signIn(operation: Operation, signal: AbortSignal): Promise<void> {
    this.stage(operation, 'authorizing')
    let complete: z.infer<typeof LoginComplete> | undefined
    const login = await this.cli.run(['auth', 'login', '--json'], signal, {
      timeoutMs: this.limits.authorizationTimeoutMs,
      onLine: (stream, line) => {
        if (stream !== 'stdout' || !line.startsWith('{')) return
        const event: unknown = JSON.parse(line)
        const link = LoginLink.safeParse(event)
        if (link.success) this.offer(operation, link.data.verification_uri_complete)
        const done = LoginComplete.safeParse(event)
        if (done.success) complete = done.data
      },
    })
    // Exit code 3 reports a sign-in that completed without every requested permission.
    if (complete === undefined || (login.exitCode !== 0 && !(login.exitCode === 3 && complete.missing.length > 0))) {
      throw new Error('feishu: auth login did not complete')
    }
    this.ungranted = complete.missing.length === 0 ? undefined : { openId: complete.user_open_id, count: complete.missing.length }
    this.stage(operation, 'verifying')
    const found = await this.check(signal)
    if (found.account.state !== 'connected' || found.openId !== complete.user_open_id) throw new Error('feishu: sign-in did not verify')
  }

  /** Read the default account, publish what it shows, and return it with the signed-in user's id. */
  private async check(signal: AbortSignal): Promise<Check> {
    const args = ['auth', 'status', '--verify', '--json']
    const result = await this.cli.run(args, signal, { timeoutMs: this.limits.commandTimeoutMs })
    if (result.exitCode !== 0) {
      if (!NotConfigured.safeParse(parseJson(args, result.stderr)).success) throw new Error('feishu: auth status failed')
      this.ungranted = undefined
      return { account: this.publish({ state: 'unconfigured' }) }
    }
    const status = Status.parse(parseJson(args, result.stdout))
    const appId = brandString<FeishuAppId>(status.appId)
    const user = status.identities.user
    if (!user.available || user.verified !== true) {
      const signedOut = SIGNED_OUT.has(user.status)
      if (signedOut) this.ungranted = undefined
      return { account: this.publish({ state: signedOut ? 'signed-out' : 'unverified', appId }), openId: user.openId }
    }
    const ungranted = this.ungranted !== undefined && this.ungranted.openId === user.openId ? this.ungranted.count : undefined
    const account: FeishuAccountState = {
      state: 'connected',
      appId,
      ...user.userName === undefined ? {} : { userName: user.userName },
      ...ungranted === undefined ? {} : { ungrantedPermissions: ungranted },
    }
    return { account: this.publish(account), openId: user.openId }
  }

  private publish(account: FeishuAccountState): FeishuAccountState {
    this.account = account
    this.changed()
    return account
  }

  private stage(operation: Operation, phase: FeishuOperationState['phase']): void {
    operation.controller.signal.throwIfAborted()
    operation.phase = phase
    operation.authorizationUrl = undefined
    this.changed()
  }

  private offer(operation: Operation, value: string): void {
    if (operation.controller.signal.aborted || !URL.canParse(value)) return
    const url = new URL(value)
    const trusted = url.protocol === 'https:' && url.username === '' && url.password === ''
      && ['feishu.cn', 'larksuite.com'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))
    if (!trusted) return
    operation.authorizationUrl = url.href
    this.changed()
  }
}
