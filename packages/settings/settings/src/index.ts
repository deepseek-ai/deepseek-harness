/** Config-schema projection and form edits over Cordis profile patches. */
import { existsSync } from 'node:fs'
import { readFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { Context, FiberState, Service, resolveConfig, type Fiber } from '@deepseek-ai/cordis'
import type z from '@deepseek-ai/schemastery'
import { interpolate, type Entry } from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-app-boot'
import { redactSecrets, type RedactedSecret } from './redact.ts'
import { isVolatilePath, plainConfig, projectForm, volatileForm } from './schema.ts'
import type { SettingsNamespace } from './types.ts'

export { redactSecrets } from './redact.ts'
export type { RedactedSecret, RedactedValue } from './redact.ts'
export type { SettingsNamespace } from './types.ts'

/** One Loader entry's live Config fields. */
export interface SettingsDescriptor {
  ns: SettingsNamespace
  /** Whether the UI may generate a page when no custom page exists. */
  autoGenerate: boolean
  schema: unknown
  value: unknown
  revision: number
  base?: unknown
  user?: unknown
  applies: 'live'
  secrets?: RedactedSecret[]
}

/** Wire readers always request secret redaction. */
export interface SettingsDescribeOptions {
  redactSecrets?: boolean
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Schema-derived plugin configuration forms. */
    settings: SettingsForms
  }
}
/** Refusal to overwrite configuration changed since the form was read. */
export class SettingsConflictError extends Error {
  /** Stable machine code for wire layers mapping this to their own taxonomy. */
  readonly code = 'SETTINGS_CONFLICT'
  /** The revision the write expected. */
  readonly expected: number
  /** The revision the namespace actually stands at. */
  readonly actual: number

  /**
   * @param ns - the namespace whose write was refused.
   * @param expected - the revision the caller sent.
   * @param actual - the revision now stored.
   */
  constructor(ns: SettingsNamespace, expected: number, actual: number) {
    super(`settings namespace "${ns}" changed since it was read (expected revision ${String(expected)}, now ${String(actual)})`)
    this.name = 'SettingsConflictError'
    this.expected = expected
    this.actual = actual
  }
}

/** Whether a value is a plain data object (not an array, null, or class instance). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const proto: unknown = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/**
 * One path-addressed edit to a namespace's user section. Path mutation exists
 * for a caller holding an INCOMPLETE view of the section — a configuration UI
 * reads the redacted descriptor, which by construction never received the
 * `role('secret')` fields. Such a caller can name the field it means without
 * restating the section: a wholesale `replace` rebuilt from a redacted
 * document silently deletes every secret the wire never returned.
 */
export type SettingsPathOp =
  | { op: 'set'; path: readonly string[]; value: unknown }
  | { op: 'unset'; path: readonly string[] }

/** Apply one path op to a detached section, returning the next section. */
function applyPathOp(section: Record<string, unknown>, op: SettingsPathOp, schema: z): Record<string, unknown> {
  const edit = (input: unknown, path: readonly string[], node?: z): unknown => {
    const [head, ...rest] = path
    if (head === undefined) return op.op === 'set' ? op.value : undefined
    const value: unknown = input === undefined ? node?.meta.default : input
    if (Array.isArray(value)) {
      if (!/^(0|[1-9][0-9]*)$/.test(head) || (Number(head) > value.length || Number(head) === value.length && (rest.length > 0 || op.op === 'unset'))) {
        throw new TypeError(`Config array index "${head}" is out of range`)
      }
      const result: unknown[] = [...value as unknown[]]
      const index = Number(head)
      if (rest.length === 0 && op.op === 'unset') result.splice(index, 1)
      else result[index] = edit(value[index], rest, node?.inner)
      return result
    }
    const result = isPlainObject(value) ? { ...value } : {}
    const child = edit(Object.hasOwn(result, head) ? result[head] : undefined, rest, node?.dict?.[head] ?? node?.inner)
    if (child === undefined) Reflect.deleteProperty(result, head)
    else Object.defineProperty(result, head, { value: child, enumerable: true, writable: true, configurable: true })
    return result
  }
  const result = edit(section, op.path, schema)
  if (!isPlainObject(result)) throw new TypeError('Config root must be a plain object')
  return result
}

/** Human label for a value that lossless JSON cannot represent (numbers reject inline). */
function describeRejected(value: unknown): string {
  if (value === undefined) return 'undefined'
  if (typeof value === 'object' && value !== null) {
    const proto = Object.getPrototypeOf(value) as { constructor?: { name?: string } } | null
    const name = proto?.constructor?.name
    return name === undefined || name === 'Object' ? 'a non-plain object' : `a ${name}`
  }
  return `a ${typeof value}`
}

/**
 * Detach and validate one write input in a single walk before persistence:
 * only JSON data (plain objects, arrays, strings, finite numbers,
 * booleans, `null`) may reach a provider document. `structuredClone` alone
 * would admit Dates, Maps, BigInts, and cycles that YAML/JSON storage then
 * silently distorts on the reload round-trip. `undefined` entries in objects
 * are skipped — the same sparse-patch semantics as {@link mergeLayers} — while
 * an `undefined` array entry is rejected rather than coerced.
 * @param root - write input to validate before merging.
 * @returns the detached JSON-compatible clone.
 */
function cloneJsonShaped(root: object): Record<string, unknown> {
  const reject = (label: string, path: string): TypeError => new TypeError(`Config ${path} contains ${label}`)
  if (!isPlainObject(root)) throw reject('a non-plain root', '$')
  const visiting = new WeakSet<object>()
  const clone = (value: unknown, path: string): unknown => {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw reject('a non-finite number', path)
      return value
    }
    if (Array.isArray(value)) {
      if (visiting.has(value)) throw reject('a circular reference', path)
      visiting.add(value)
      const entries = value.map((entry, index) => clone(entry, `${path}[${index}]`))
      // Un-mark on exit so one object referenced twice without a cycle passes.
      visiting.delete(value)
      return entries
    }
    if (isPlainObject(value)) {
      if (visiting.has(value)) throw reject('a circular reference', path)
      visiting.add(value)
      const out: Record<string, unknown> = {}
      for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) continue
        Object.defineProperty(out, key, { value: clone(entry, `${path}.${key}`), enumerable: true, configurable: true, writable: true })
      }
      visiting.delete(value)
      return out
    }
    throw reject(describeRejected(value), path)
  }
  return clone(root, '$') as Record<string, unknown>
}

/**
 * Layer `over` onto `under`: plain objects merge recursively, every other
 * value (arrays included) replaces the lower layer wholesale. `over` never
 * carries `undefined` entries — sections come from parsed documents and write
 * snapshots pass {@link cloneJsonShaped}, which strips them so a sparse patch
 * cannot erase lower keys.
 */
function mergeLayers(under: unknown, over: unknown): unknown {
  if (!isPlainObject(under) || !isPlainObject(over)) return over
  const merged: Record<string, unknown> = { ...under }
  for (const [key, value] of Object.entries(over)) {
    Object.defineProperty(merged, key, {
      value: Object.hasOwn(merged, key) ? mergeLayers(merged[key], value) : value,
      enumerable: true, configurable: true, writable: true,
    })
  }
  return merged
}


/** Read one member of a plain object or array; `own` limits the read to own properties.
 * @param node Candidate container.
 * @param key Member name.
 * @param own Whether inherited members count as absent.
 * @returns The member, or undefined when the node is not a container or lacks the member.
 */
function member(node: unknown, key: string, own = false): unknown {
  if (!(isPlainObject(node) || Array.isArray(node)) || (own && !Object.hasOwn(node, key))) return undefined
  const value: unknown = Reflect.get(node, key)
  return value
}

/** Entry ids of the removed `settings.yaml` sections whose owning entry carries another id. */
const LEGACY_SECTION_ENTRIES: Record<string, string> = {
  'ui-developer-tools': 'ui-settings',
  'ui-onboarding': 'ui-settings-general',
  /* v8 ignore next -- the base bundle composes one shell executor per platform */
  shell: process.platform === 'win32' ? 'pwsh-sandbox' : 'bash-sandbox',
}

/** Resolve the inherited layers alone, or keep their raw values when required fields arrive only through the profile.
 * @param runtime Plugin runtime owning the Config schema.
 * @param inherited Interpolated config beneath the profile override.
 * @returns Values the profile override sits on.
 */
function inheritedConfig(runtime: Fiber['runtime'] & object, inherited: unknown): unknown {
  try {
    return resolveConfig(runtime, inherited)
  } catch (_error) {
    // The profile override supplies fields the inherited layers lack; the form shows their raw values as the base.
    return inherited
  }
}

/** Project Config schemas into forms and own optional instance-level UI policy. */
export class SettingsForms extends Service {
  static inject = ['configEditor', 'profileContext']
  private revisions = new Map<string, { raw: string | undefined; revision: number; ns: SettingsNamespace; autoGenerate: boolean }>()
  private closed = false
  private scheduled = false
  private readonly presentations = new Map<Fiber, { auto?: boolean }>()

  constructor(private readonly ownerContext: Context) {
    super(ownerContext, 'settings')
    const ctx = ownerContext
    ctx.effect(() => () => { this.closed = true })
    ctx.on('app-boot/config-reload', () => { this.invalidate() })
    void ctx.root.loader.await().then(() => this.importLegacyDocument()).catch((error: unknown) => { ctx.logger.error(error) })
  }

  /** Move the sections of the removed `settings.yaml` into the active profile once the Loader has settled every entry.
   * The document is renamed before the first write, so a partial import never repeats; a section the running
   * composition rejects is logged and remains only in the renamed file. */
  private async importLegacyDocument(): Promise<void> {
    const profile = this.ownerContext.profileContext
    const path = join(profile.home, 'settings.yaml')
    if (!existsSync(path)) return
    const imported = `${path}.imported`
    await rename(path, imported)
    const sections = parse(await readFile(imported, 'utf8')) as Record<string, object> | null
    for (const [section, values] of Object.entries(sections ?? {})) {
      const ns = LEGACY_SECTION_ENTRIES[section] ?? section
      try {
        await this.update(ns, values)
      } catch (error) {
        this.ownerContext.logger.warn('settings: section %s of %s was not imported into entry %s', section, imported, ns)
        this.ownerContext.logger.warn(error)
      }
    }
    this.ownerContext.logger.info('settings: imported %s into profile %s', imported, profile.name)
  }

  /** Register the calling plugin instance's page policy without changing its Config.
   * @param presentation Automatic-page policy for this instance; `auto` defaults to true.
   * @param owner Plugin instance the policy belongs to; defaults to the calling fiber.
   * @returns Disposer; register it with the calling plugin's effects.
   * @throws If this instance already has a registered policy.
   */
  configure(presentation: { auto?: boolean }, owner: Fiber = this.ctx.fiber): () => void {
    const fiber = owner
    if (this.presentations.has(fiber)) throw new Error('Settings presentation is already configured for this plugin instance')
    const policy = { ...presentation }
    this.presentations.set(fiber, policy)
    this.invalidate()
    return () => {
      if (this.presentations.get(fiber) !== policy) return
      this.presentations.delete(fiber)
      this.invalidate()
    }
  }

  private invalidate(): void {
    if (this.scheduled || this.closed) return
    this.scheduled = true
    queueMicrotask(() => {
      this.scheduled = false
      if (this.closed || this.ownerContext.fiber.state !== FiberState.ACTIVE) return
      try { this.describe() } catch (error) { this.ownerContext.logger.error(error) }
    })
  }

  /** Whether the active profile accepts form edits. */
  get writable(): boolean { return true }
  /** Current profile patch shown by the native configuration editor. */
  get documentPath(): string { return this.ownerContext.configEditor.documentPath }
  /** Locate the profile patch for native editing.
   * @returns The existing profile patch path.
   */
  prepareDocument(): Promise<string> { return Promise.resolve(this.documentPath) }

  /** Read active plugin schemas and their live values.
   * @param options Redaction required for remote callers.
   * @returns Forms keyed by unique profile entry ids.
   */
  describe(options?: SettingsDescribeOptions): SettingsDescriptor[] {
    const active = new Set<string>()
    const descriptors = this.ownerContext.configEditor.configuration().flatMap(({ entry, inherited, override }) => {
      const schema = this.schema(entry)
      if (schema === undefined || entry.fiber === undefined
        || entry.fiber.runtime === null || entry.fiber.state !== FiberState.ACTIVE) return []
      const form = volatileForm(schema)
      if (form === undefined) return []
      active.add(entry.id)
      const raw = JSON.stringify([entry.fiber.uid, schema.toJSON(), entry.options.config ?? {}])
      const autoGenerate = this.presentations.get(entry.fiber)?.auto ?? true
      const previous = this.revisions.get(entry.id)
      const revision = previous === undefined ? 0 : previous.revision + Number(previous.raw !== raw)
      this.revisions.set(entry.id, { raw, revision, ns: entry.options.id as SettingsNamespace, autoGenerate })
      if (previous?.raw !== raw || previous.autoGenerate !== autoGenerate) {
        this.ownerContext.emit('settings/document-updated', entry.options.id as SettingsNamespace, revision)
      }
      const value = projectForm(form, plainConfig(entry.fiber.config))
      const resolved: unknown = interpolate(entry.fiber.ctx, inherited)
      const base = projectForm(form, plainConfig(inheritedConfig(entry.fiber.runtime, resolved)))
      const user = projectForm(form, override)
      const redacted = redactSecrets(form as z<never>, value)
      return [{
        autoGenerate,
        ns: entry.options.id as SettingsNamespace, schema: form.toJSON(), revision, applies: 'live' as const,
        value: options?.redactSecrets ? redacted.value : value,
        base: options?.redactSecrets ? redactSecrets(form as z<never>, base).value : base,
        user: options?.redactSecrets ? redactSecrets(form as z<never>, user).value : user,
        ...options?.redactSecrets ? { secrets: redacted.secrets } : {},
      }]
    })
    for (const [id, previous] of this.revisions) {
      if (active.has(id) || previous.raw === undefined) continue
      const revision = previous.revision + 1
      this.revisions.set(id, { ...previous, raw: undefined, revision })
      this.ownerContext.emit('settings/document-updated', previous.ns, revision)
    }
    return descriptors
  }

  /** Merge editable fields into an entry's config.
   * @param ns Profile entry id.
   * @param patch Fields to merge.
   * @param expectedRevision Revision returned by describe.
   */
  async update(ns: string, patch: object, expectedRevision?: number): Promise<void> {
    const input = cloneJsonShaped(patch)
    await this.write(ns, current => mergeLayers(current, input) as Record<string, unknown>, expectedRevision)
  }

  /** Reset all live fields, then set the supplied fields; ordinary config is preserved.
   * @param ns Profile entry id.
   * @param section Complete form values.
   * @param expectedRevision Revision returned by describe.
   */
  async replace(ns: string, section: object, expectedRevision?: number): Promise<void> {
    const input = cloneJsonShaped(section)
    await this.write(ns, (_current, base) => mergeLayers(base, input) as Record<string, unknown>, expectedRevision)
  }

  /** Apply field edits without restating redacted secrets; unsetting an array index removes its element.
   * @param ns Profile entry id.
   * @param ops Ordered form edits.
   * @param expectedRevision Revision returned by describe.
   */
  async mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void> {
    await this.write(ns, (current, base, schema) => ops.reduce((value, op) => {
      if (op.op === 'set') return applyPathOp(value, op, schema)
      const parent = op.path.slice(0, -1).reduce<unknown>((node, key) => member(node, key), value)
      if (Array.isArray(parent)) return applyPathOp(value, op, schema)
      const inherited = op.path.reduce<unknown>((node, key) => member(node, key, true), base)
      return applyPathOp(value, inherited === undefined ? op : { op: 'set', path: op.path, value: inherited }, schema)
    }, current), expectedRevision, ops.map(op => op.path))
  }

  private async write(
    ns: string,
    change: (current: Record<string, unknown>, base: Record<string, unknown>, schema: z) => Record<string, unknown>,
    expected?: number, paths: readonly (readonly string[])[] = [],
  ): Promise<void> {
    const entry = this.ownerContext.configEditor.entries().find(row => row.options.id === ns)
    const schema = entry === undefined ? undefined : this.schema(entry)
    if (entry === undefined || schema === undefined) throw new Error(`No configurable plugin entry "${ns}"`)
    const form = volatileForm(schema)
    if (form === undefined) throw new Error(`Plugin entry "${ns}" has no volatile fields`)
    for (const path of paths) {
      if (path.length && !isVolatilePath(schema, path)) throw new Error(`Config field "${path.join('.')}" is not volatile`)
    }
    await this.ownerContext.configEditor.edit(entry, (raw, inherited) => {
      const descriptor = this.describe().find(row => row.ns === ns)
      if (descriptor === undefined) throw new Error(`Plugin entry "${ns}" is no longer configurable`)
      if (expected !== undefined && descriptor.revision !== expected) {
        throw new SettingsConflictError(ns as SettingsNamespace, expected, descriptor.revision)
      }
      const current = projectForm(form, raw) as Record<string, unknown>
      const base = projectForm(form, inherited) as Record<string, unknown>
      const next = cloneJsonShaped(change(current, base, schema))
      const validatePaths = (value: Record<string, unknown>, node: z, path: string[] = []): void => {
        for (const [key, child] of Object.entries(value)) {
          const target = [...path, key]
          if (isVolatilePath(schema, target)) continue
          const fields = node.dict as Record<string, z>
          const field = Object.hasOwn(fields, key) ? fields[key] : undefined
          if (isPlainObject(child) && field !== undefined) validatePaths(child, field, target)
          else throw new Error(`Config field "${target.join('.')}" is not volatile`)
        }
      }
      validatePaths(next, form)
      const strip = (value: Record<string, unknown>, node: z, path: string[] = []): Record<string, unknown> => {
        if (isVolatilePath(schema, path)) return {}
        const result = { ...value }
        for (const [key, field] of Object.entries(node.dict as Record<string, z>)) {
          const target = [...path, key]
          if (isVolatilePath(schema, target)) Reflect.deleteProperty(result, key)
          else if (isPlainObject(result[key])) result[key] = strip(result[key], field, target)
        }
        return result
      }
      return mergeLayers(strip(raw, form), next) as Record<string, unknown>
    })
    this.describe()
  }

  private schema(entry: Entry): z | undefined {
    const schema = entry.fiber?.runtime?.Config
    return schema !== undefined && 'toJSON' in schema ? schema as z : undefined
  }
}

export default SettingsForms
