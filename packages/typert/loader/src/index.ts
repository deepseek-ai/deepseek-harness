/**
 * Typert Loader integration: automatic registration for mounted plugin packages.
 *
 * When a loader entry mounts, this plugin resolves the entry's package.json; a
 * package exporting `./typert` has its host face imported and its
 * `TYPERT` manifest registered into `ctx.typert`, and the registration is
 * withdrawn when the entry unmounts. Explicit `packages` cover plugins nested
 * behind another Loader entry, whose Cordis fibers carry no resolvable package
 * specifier. Packages without the export are skipped silently when discovered
 * from Loader entries; an explicit package or declared artifact that is broken
 * fails loud — aggregated into this plugin's activation throw for existing
 * entries, contained to a logged error per package in steady state.
 *
 * Scanning is incremental per entry name. Every cordis `internal/plugin`
 * emission marks the fiber's entry name dirty, and a microtask flush
 * reconciles each dirty name against the live
 * loader entries; the activation pass seeds the same dirty set with all
 * current entries. Package verdicts and imported manifests are cached per
 * package name and never expire — plugin-set changes take effect on restart.
 *
 * Manual `ctx.typert.register()` remains available for contributions
 * that do not use a `./typert` artifact (hand-written wire schemas,
 * tests, non-loader compositions).
 *
 * @module @deepseek-ai/dsh-typert-loader
 */

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-typert-registry'
import type { TypertContribution } from '@deepseek-ai/dsh-typert-registry/types'

/** The package.json exports key naming a package's host-face typert artifact. */
export const TYPERT_HOST_EXPORT = './typert'

/** Cordis plugin name. */
export const name = 'typert-loader'
/** Services required before registration: the registry this plugin feeds and the Loader it observes. */
export const inject = ['typert', 'loader']

/** Additional package artifacts whose owning plugins are nested behind another Loader entry. */
export interface Config {
  /** Exact npm package names that must resolve and export `./typert`. */
  packages?: string[]
}

/** Validate explicit package names and default to Loader-entry discovery only. */
export const Config: z<Config> = z.object({
  packages: z.array(z.string().min(1)).default([]),
})

type ResolvedConfig = Required<Config>

interface TypertArtifact {
  packageName: string
  path: string
}

const MEMBER_KINDS = new Set(['property', 'method', 'getter', 'setter', 'call', 'construct', 'index'])

/** Resolve the `./typert` export to a relative path, accepting the string and one-level conditional forms. */
function typertExportOf(pkgName: string, exportsField: unknown): string | undefined {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined
  const target = (exportsField as Record<string, unknown>)[TYPERT_HOST_EXPORT]
  if (target === undefined) return undefined
  if (typeof target === 'string') return target
  if (typeof target === 'object' && target !== null) {
    const fallback = (target as Record<string, unknown>).default
    if (typeof fallback === 'string') return fallback
  }
  throw new Error(`typert-loader: ${pkgName} exports["${TYPERT_HOST_EXPORT}"] must be a string or an object with a string default`)
}

/**
 * Narrow a dynamically imported typert module's `TYPERT` export to a
 * contribution owned by `pkgName`. This is the module/file boundary: the
 * manifest crosses from a build artifact into the typed registry, so every
 * field is checked and every failure names the package and the defect.
 * @param pkgName - the package whose typert face was imported.
 * @param exported - the module's `TYPERT` export.
 * @returns the validated contribution.
 */
export function validateTypertManifest(pkgName: string, exported: unknown): TypertContribution {
  if (typeof exported !== 'object' || exported === null) {
    throw new Error(`typert-loader: ${pkgName} exports "${TYPERT_HOST_EXPORT}" but its module has no TYPERT manifest object`)
  }
  const manifest = exported as Record<string, unknown>
  if (manifest.package !== pkgName) {
    throw new Error(
      `typert-loader: ${pkgName} TYPERT manifest names package ${JSON.stringify(manifest.package)} — the manifest must be owned by the package that exports it`,
    )
  }
  if (manifest.face !== 'host') {
    throw new Error(`typert-loader: ${pkgName} exports "${TYPERT_HOST_EXPORT}" but TYPERT.face is not "host"`)
  }
  if (!Array.isArray(manifest.schemas)) {
    throw new Error(`typert-loader: ${pkgName} TYPERT.schemas must be an array`)
  }
  for (const value of manifest.schemas as unknown[]) {
    if (typeof value !== 'object' || value === null) {
      throw new Error(`typert-loader: ${pkgName} TYPERT.schemas contains a non-object schema`)
    }
    const schema = value as Record<string, unknown>
    requireString(pkgName, schema, 'name', 'schema')
    if (typeof schema.create !== 'function') {
      throw new Error(`typert-loader: ${pkgName} TYPERT schema "${schema.name as string}" has no create() factory`)
    }
  }
  const model = requireObject(pkgName, manifest.model, 'TYPERT.model')
  const services = requireArray(pkgName, model.services, 'TYPERT.model.services')
  const events = requireArray(pkgName, model.events, 'TYPERT.model.events')
  const objects = requireArray(pkgName, model.objects, 'TYPERT.model.objects')
  for (const value of services) {
    const service = requireObject(pkgName, value, 'service')
    requireDocumentation(pkgName, service, 'service')
    requireString(pkgName, service, 'key', 'service')
    requireString(pkgName, service, 'exportName', 'service')
    requireMembers(pkgName, service.members, `service "${service.key as string}"`)
    requireTypes(pkgName, service.types, `service "${service.key as string}"`)
  }
  for (const value of events) {
    const event = requireObject(pkgName, value, 'event')
    requireDocumentation(pkgName, event, 'event')
    requireString(pkgName, event, 'name', 'event')
    requireString(pkgName, event, 'signature', `event "${event.name as string}"`)
    if (event.mode !== undefined && typeof event.mode !== 'string') {
      throw new Error(`typert-loader: ${pkgName} event "${event.name as string}" mode must be a string`)
    }
  }
  for (const value of objects) {
    const object = requireObject(pkgName, value, 'object')
    requireDocumentation(pkgName, object, 'object')
    requireString(pkgName, object, 'name', 'object')
    requireString(pkgName, object, 'exportName', 'object')
    requireMembers(pkgName, object.members, `object "${object.name as string}"`)
    requireTypes(pkgName, object.types, `object "${object.name as string}"`)
  }
  for (const value of requireArray(pkgName, manifest.invocations, 'TYPERT.invocations')) {
    requireInvocation(pkgName, value)
  }
  return manifest as unknown as TypertContribution
}

function requireObject(pkgName: string, value: unknown, subject: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`typert-loader: ${pkgName} ${subject} must be an object`)
  }
  return value as Record<string, unknown>
}

function requireArray(pkgName: string, value: unknown, subject: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`typert-loader: ${pkgName} ${subject} must be an array`)
  return value
}

function requireString(pkgName: string, value: Record<string, unknown>, key: string, subject: string): void {
  if (typeof value[key] !== 'string' || value[key].length === 0) {
    throw new Error(`typert-loader: ${pkgName} ${subject} has a missing or empty ${key}`)
  }
}

function requireDocumentation(pkgName: string, value: Record<string, unknown>, subject: string): void {
  requireArray(pkgName, value.tags, `${subject}.tags`)
  for (const key of ['description', 'summary', 'jsDoc'] as const) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Error(`typert-loader: ${pkgName} ${subject}.${key} must be a string`)
    }
  }
}

function requireMembers(pkgName: string, value: unknown, subject: string): void {
  for (const item of requireArray(pkgName, value, `${subject}.members`)) {
    const member = requireObject(pkgName, item, `${subject} member`)
    requireString(pkgName, member, 'name', `${subject} member`)
    requireString(pkgName, member, 'signature', `${subject} member`)
    if (typeof member.kind !== 'string' || !MEMBER_KINDS.has(member.kind)) {
      throw new Error(`typert-loader: ${pkgName} ${subject} member "${member.name as string}" has invalid kind`)
    }
  }
}

function requireTypes(pkgName: string, value: unknown, subject: string): void {
  for (const item of requireArray(pkgName, value, `${subject}.types`)) {
    const type = requireObject(pkgName, item, `${subject} type`)
    requireString(pkgName, type, 'name', `${subject} type`)
    requireString(pkgName, type, 'declaration', `${subject} type`)
  }
}

function requireInvocation(pkgName: string, value: unknown): void {
  const invocation = requireObject(pkgName, value, 'invocation')
  for (const key of ['id', 'service', 'namespace', 'method'] as const) {
    requireString(pkgName, invocation, key, 'invocation')
  }
  const id = invocation.id as string
  const receiver = requireObject(pkgName, invocation.invocation, `invocation "${id}" receiver`)
  if (receiver.kind === 'context') {
    requireString(pkgName, receiver, 'context', `invocation "${id}" Context receiver`)
    requireString(pkgName, receiver, 'wire', `invocation "${id}" Context receiver`)
    requireStrictCodec(pkgName, receiver.codec, `invocation "${id}" Context codec`)
  } else if (receiver.kind !== 'direct') {
    throw new Error(`typert-loader: ${pkgName} invocation "${id}" receiver kind must be "direct" or "context"`)
  }
  const wires = new Set<string>()
  const parameters = new Map<string, Record<string, unknown>>()
  let lookupCount = 0
  for (const valueParameter of requireArray(pkgName, invocation.parameters, `invocation "${id}" parameters`)) {
    const parameter = requireObject(pkgName, valueParameter, `invocation "${id}" parameter`)
    requireString(pkgName, parameter, 'name', `invocation "${id}" parameter`)
    requireString(pkgName, parameter, 'wire', `invocation "${id}" parameter`)
    const wire = parameter.wire as string
    if (wires.has(wire)) {
      throw new Error(`typert-loader: ${pkgName} invocation "${id}" repeats wire field "${wire}"`)
    }
    wires.add(wire)
    if (parameter.source === 'lookup') {
      lookupCount += 1
      requireString(pkgName, parameter, 'lookup', `invocation "${id}" lookup parameter`)
    } else if (parameter.source === 'json') {
      if (parameter.lookup !== undefined) {
        throw new Error(`typert-loader: ${pkgName} invocation "${id}" JSON parameter declares a lookup`)
      }
    } else {
      throw new Error(`typert-loader: ${pkgName} invocation "${id}" parameter source must be "json" or "lookup"`)
    }
    parameters.set(wire, parameter)
    requireStrictCodec(pkgName, parameter.codec, `invocation "${id}" parameter codec`)
  }
  if (invocation.cancellation !== undefined) {
    const cancellation = requireObject(pkgName, invocation.cancellation, `invocation "${id}" cancellation`)
    if (cancellation.parameter !== 'signal') {
      throw new Error(`typert-loader: ${pkgName} invocation "${id}" cancellation parameter must be "signal"`)
    }
  }
  if (invocation.scope !== undefined) {
    if (receiver.kind !== 'direct') {
      throw new Error(`typert-loader: ${pkgName} invocation "${id}" Context receiver cannot declare a direct scope projection`)
    }
    const scope = requireObject(pkgName, invocation.scope, `invocation "${id}" scope`)
    requireString(pkgName, scope, 'context', `invocation "${id}" scope`)
    requireString(pkgName, scope, 'wire', `invocation "${id}" scope`)
    const parameter = parameters.get(scope.wire as string)
    if (lookupCount !== 1 || parameter?.source !== 'lookup' || parameter.lookup !== scope.context) {
      throw new Error(
        `typert-loader: ${pkgName} invocation "${id}" scope wire "${scope.wire as string}" must select its only lookup parameter`,
      )
    }
  }
  if (receiver.kind === 'context' && wires.has(receiver.wire as string)) {
    throw new Error(`typert-loader: ${pkgName} invocation "${id}" repeats Context wire field "${receiver.wire as string}"`)
  }
  requireStrictCodec(pkgName, invocation.result, `invocation "${id}" result codec`)
  if (invocation.sourceLocation !== undefined) {
    const location = requireObject(pkgName, invocation.sourceLocation, `invocation "${id}" sourceLocation`)
    requireString(pkgName, location, 'file', `invocation "${id}" sourceLocation`)
    for (const key of ['line', 'column'] as const) {
      if (!Number.isInteger(location[key]) || (location[key] as number) < 1) {
        throw new Error(`typert-loader: ${pkgName} invocation "${id}" sourceLocation.${key} must be a positive integer`)
      }
    }
  }
}

function requireStrictCodec(pkgName: string, value: unknown, subject: string): void {
  const codec = requireObject(pkgName, value, subject)
  if (codec.mode !== 'strict') {
    throw new Error(`typert-loader: ${pkgName} ${subject} must use a strict codec`)
  }
  requireString(pkgName, codec, 'typeSymbol', subject)
  if (typeof codec.create !== 'function') {
    throw new Error(`typert-loader: ${pkgName} ${subject} has no create() factory`)
  }
}

/**
 * Scan current Loader entries during activation, then follow entry mounts and
 * unmounts for this plugin's lifetime.
 * @param ctx - plugin context carrying `typert` and `loader`.
 * @param config - explicit package artifacts in addition to Loader entries.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  // Resolution anchor: the config tree's baseUrl (the cordis.yml directory,
  // whose package declares every composed plugin as a dependency). This
  // package's own URL would miss sibling packages under pnpm's isolated
  // node_modules.
  if (ctx.baseUrl === undefined) {
    throw new Error('typert-loader: ctx.baseUrl is unset — the loader needs the config-tree anchor to resolve plugin packages')
  }
  const baseUrl = ctx.baseUrl
  const require = createRequire(baseUrl)
  const configured = new Set((config as ResolvedConfig).packages)

  // Registered contributions by entry name; the disposer withdraws the entry's registration.
  const registered = new Map<string, () => Promise<void>>()
  // In-flight import/register tasks by entry name.
  const pending = new Map<string, Promise<void>>()
  // Artifact paths by package name. Negative verdicts (unresolvable specifier —
  // unconfigured loader builtins and subpath rows — or no typert export) are
  // cached as null and never expire: plugin-set changes take effect on restart.
  const artifactPath = new Map<string, TypertArtifact | null>()
  // Imported+validated manifests by package name (one import per package per process).
  const manifests = new Map<string, Promise<TypertContribution>>()
  const dirty = new Set<string>()
  let flushQueued = false
  let active = true
  ctx.effect(function* () {
    yield () => {
      active = false
      dirty.clear()
    }
  }, 'typert loader lifetime')

  const resolveArtifact = (pkgName: string): TypertArtifact | null => {
    const cached = artifactPath.get(pkgName)
    if (cached !== undefined) return cached
    const firstSlash = pkgName.indexOf('/')
    if (firstSlash >= 0 && (pkgName[0] !== '@' || pkgName.indexOf('/', firstSlash + 1) >= 0)) {
      if (configured.has(pkgName)) {
        throw new Error(
          `typert-loader: configured package "${pkgName}" cannot be resolved from the config tree — add it to the composition package dependencies or remove it from packages`,
        )
      }
      artifactPath.set(pkgName, null)
      return null
    }
    let pkgPath: string
    let pkg: Record<string, unknown> | undefined
    try {
      const packages = ctx.get('pluginPackages')
      const resolvedPackage = packages?.packageOf(pkgName, baseUrl)
      if (packages !== undefined && resolvedPackage === undefined) throw new Error('package is absent from the active resolver')
      pkgPath = resolvedPackage === undefined
        ? require.resolve(`${pkgName}/package.json`)
        : resolvedPackage.manifestPath
      pkg = resolvedPackage?.manifest
    } catch (cause) {
      if (configured.has(pkgName)) {
        throw new Error(
          `typert-loader: configured package "${pkgName}" cannot be resolved from the config tree — add it to the composition package dependencies or remove it from packages`,
          { cause },
        )
      }
      // Not a resolvable package root: loader builtins (cordis:include) and
      // subpath entries land here — permanently not a typert contributor.
      artifactPath.set(pkgName, null)
      return null
    }
    pkg ??= JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, unknown>
    const manifestName = typeof pkg.name === 'string' ? pkg.name : pkgName
    const rel = typertExportOf(manifestName, pkg.exports)
    if (rel === undefined && configured.has(pkgName)) {
      throw new Error(`typert-loader: configured package "${pkgName}" does not export "${TYPERT_HOST_EXPORT}"`)
    }
    const resolved = rel === undefined ? null : { packageName: manifestName, path: join(dirname(pkgPath), rel) }
    artifactPath.set(pkgName, resolved)
    return resolved
  }

  const loadManifest = (pkgName: string, path: string): Promise<TypertContribution> => {
    let loading = manifests.get(pkgName)
    if (loading === undefined) {
      loading = import(pathToFileURL(path).href).then(
        (mod: Record<string, unknown>) => validateTypertManifest(pkgName, mod.TYPERT),
        (cause: unknown) => {
          throw new Error(
            `typert-loader: ${pkgName} exports "${TYPERT_HOST_EXPORT}" but importing ${path} failed: ${String(cause)}`,
          )
        },
      )
      manifests.set(pkgName, loading)
    }
    return loading
  }

  const qualifies = (entryName: string): boolean => {
    if (configured.has(entryName)) return true
    for (const entry of ctx.loader.entries()) {
      if (entry.options.name === entryName && entry.fiber !== undefined && !entry.disabled) return true
    }
    return false
  }

  /** Reconcile one entry name against the live loader entries; a mount returns its async task. */
  const processOne = (entryName: string): Promise<void> | undefined => {
    if (!qualifies(entryName)) {
      const dispose = registered.get(entryName)
      if (dispose !== undefined) {
        registered.delete(entryName)
        return dispose()
      }
      return undefined
    }
    if (registered.has(entryName) || pending.has(entryName)) return undefined
    const artifact = resolveArtifact(entryName)
    if (artifact === null) return undefined
    const task = loadManifest(artifact.packageName, artifact.path).then((manifest) => {
      // The entry may have unmounted (or already re-registered) while the import was in flight.
      if (!active || !qualifies(entryName) || registered.has(entryName)) return
      registered.set(entryName, ctx.typert.register(manifest))
    })
    pending.set(entryName, task)
    // Two-armed settle: a bare .finally() would mint a second, unhandled rejection.
    const settle = (): void => { pending.delete(entryName) }
    void task.then(settle, settle)
    return task
  }

  const flush = (onError: (error: Error) => void): Promise<void>[] => {
    const tasks: Promise<void>[] = []
    for (const entryName of [...dirty]) {
      dirty.delete(entryName)
      try {
        const task = processOne(entryName)
        if (task !== undefined) tasks.push(task.catch((error: unknown) => { onError(toError(error)) }))
      } catch (error) {
        // Steady state: one broken package must not poison the others; the
        // activation pass aggregates these into a loud throw instead.
        onError(toError(error))
      }
    }
    return tasks
  }

  // Subscribe before seeding so an entry arriving mid-activation lands in the
  // same dirty set (Set idempotence makes the overlap harmless). An entry-less
  // fiber is a child plugin or a manual mount — never a loader row; O(1) drop.
  ctx.on('internal/plugin', (fiber) => {
    const entryName = fiber.entry?.options.name
    if (entryName === undefined) return
    dirty.add(entryName)
    if (flushQueued) return
    flushQueued = true
    queueMicrotask(() => {
      flushQueued = false
      if (!active) return
      for (const task of flush((err) => { ctx.logger.error(err) })) void task
    })
  })

  // Activation pass: the initial scan IS the incremental path over the current
  // entries; a malformed typert contributor among the already-loaded entries
  // aggregates into one loud throw (FAILED loader fiber; the boot sweep reports it).
  for (const packageName of configured) dirty.add(packageName)
  for (const entry of ctx.loader.entries()) dirty.add(entry.options.name)
  const failures: Error[] = []
  await Promise.all(flush((err) => { failures.push(err) }))
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `typert-loader: ${String(failures.length)} typert contributor(s) failed to register:\n${failures.map(e => `  - ${e.message}`).join('\n')}`,
    )
  }
}

/** Normalize an arbitrary import or manifest failure to an Error. */
function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
