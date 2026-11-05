/** Profile-scoped application consent over the existing domain storage service. */
import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import type {} from '@deepseek-ai/dsh-app-boot'
import { z } from 'zod'
import type { CuaApplicationGrant, CuaApplicationId } from './application-types.ts'

const identity = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/).transform(value => value as CuaApplicationId),
  name: z.string(), executablePath: z.string().min(1).optional(),
})
const sessionDecision = z.object({
  identity, decision: z.enum(['allow', 'deny', 'ask']), revision: z.number().int().nonnegative(),
})
const application = z.object({
  revoked: z.number().int().nonnegative(), always: identity.optional(),
  sessions: z.record(z.string(), sessionDecision),
})
const state = z.object({
  migrated: z.boolean(), applications: z.record(z.string().regex(/^[a-f0-9]{64}$/), application),
}).superRefine((value, context) => {
  for (const [id, app] of Object.entries(value.applications)) {
    if ((app.always !== undefined && app.always.id !== id)
      || Object.values(app.sessions).some(session => session.identity.id !== id)) {
      context.addIssue({ code: 'custom', message: 'Application identity does not match its stored key' })
    }
  }
})
/** One application's grants and revocation generations. */
export type ApplicationPermission = z.infer<typeof application>
/** Validated authoritative state; an empty migrated store never reimports legacy grants. */
export type PermissionState = z.infer<typeof state>
/** One locked storage operation, with writes resolving only after durability. */
export interface PermissionTransaction {
  state: PermissionState
  save: (next: PermissionState) => Promise<void>
}

/**
 * Open fresh domain state under a profile lock for every decision and native operation.
 * Without a profile, only process-local session decisions are writable. A profile requires domain storage.
 */
export class CuaPermissionStore {
  private readonly directory: string | undefined
  private memory: PermissionState
  private readonly pending = new Set<Promise<unknown>>()
  private tail: Promise<void> = Promise.resolve()
  /**
   * @param ctx Provider context with optional profile and domain storage services.
   * @param legacy Grants imported on the first access to this profile's store.
   * @param waitMs Existing operation budget, also bounding profile-lock contention.
   */
  constructor(private readonly ctx: Context, private readonly legacy: readonly CuaApplicationGrant[], private readonly waitMs: number) {
    this.directory = ctx.get('profileContext')?.dir
    this.memory = this.importLegacy()
  }
  /** Whether this composition can retain application and session grants across restarts. */
  get persistent(): boolean { return this.directory !== undefined && this.ctx.get('storageDomain') !== undefined }

  /**
   * Serialize a read, write, or authorized dispatch against all other users of this profile.
   * @param signal Cancellation while waiting; admitted operations own their cancellation.
   * @param operation Work using fresh state. Native dispatch uses its separate application lease.
   * @returns The operation's result after its domain handle has closed.
   */
  withState<T>(signal: AbortSignal, operation: (transaction: PermissionTransaction) => T | Promise<T>): Promise<T> {
    const pending = this.operate(signal, operation)
    this.pending.add(pending)
    void pending.finally(() => { this.pending.delete(pending) }).catch(() => {})
    return pending
  }
  /**
   * Coordinate native dispatch and whole-application revocation without blocking other applications.
   * @param id Validated native application identity.
   * @param signal Cancellation while waiting for admission.
   * @param operation Authorized dispatch or revocation, after checking fresh state separately.
   * @returns Result after releasing the application lease.
   */
  withApplication<T>(id: CuaApplicationId, signal: AbortSignal, operation: () => Promise<T>): Promise<T> {
    const pending = (async () => {
      signal.throwIfAborted()
      if (this.directory === undefined) return operation()
      const directory = await realpath(this.directory)
      return withFileLock(join(directory, `cua-application-${id}`), operation, { signal, waitMs: this.waitMs })
    })()
    this.pending.add(pending)
    void pending.finally(() => { this.pending.delete(pending) }).catch(() => {})
    return pending
  }

  /** Join accepted operations before withdrawing this provider. */
  async drain(): Promise<void> { await Promise.allSettled(this.pending) }

  private async operate<T>(signal: AbortSignal, operation: (transaction: PermissionTransaction) => T | Promise<T>): Promise<T> {
    if (this.directory === undefined) {
      const run = async (): Promise<T> => {
        signal.throwIfAborted()
        return operation({ state: this.memory, save: (next) => { this.memory = next; return Promise.resolve() } })
      }
      const pending = this.tail.then(run)
      this.tail = pending.then(() => {}, () => {})
      return pending
    }
    const storage = this.ctx.get('storageDomain')
    if (storage === undefined) throw new Error('Profile application permissions require storageDomain')
    const directory = await realpath(this.directory)
    const name = `cua_permissions_${createHash('sha256').update(directory).digest('hex')}`
    const spec = defineDomain({ name, version: 1, tables: {}, global: {
      schema: state, initial: { migrated: false, applications: {} },
    } })
    return withFileLock(join(directory, 'cua-permissions'), async () => {
      const domain = await storage.open(spec)
      try {
        if (!domain.global.get().migrated) await domain.global.set(this.importLegacy())
        return await operation({ state: domain.global.get(), save: next => domain.global.set(next) })
      } finally { await domain.close() }
    }, { signal, waitMs: this.waitMs })
  }

  private importLegacy(): PermissionState {
    return { migrated: true, applications: Object.fromEntries(this.legacy.map(grant => [grant.id, {
      revoked: 0, always: grant, sessions: {},
    }])) }
  }
}
