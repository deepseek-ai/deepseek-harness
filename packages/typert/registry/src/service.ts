/**
 * Runtime registry for generated Typert reflection, Remote invocations, and
 * dependency-inverted lookup/Context providers. It performs no TypeScript
 * analysis or schema generation.
 * @module @deepseek-ai/dsh-typert-registry
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { z } from 'zod'
import type {
  InvocationDescriptor,
  TypertClientContextAdapter,
  TypertContextMap,
  TypertContextRegistry,
  TypertContextWire,
  TypertDisposer,
  TypertHostContextAdapter,
  TypertHostContextResolver,
  TypertLocalRegistry,
  TypertLookupHost,
  TypertLookupDefinition,
  TypertLookupMap,
  TypertLookupProvider,
  TypertLookupResolver,
  TypertLookupRegistry,
  TypertLookupWire,
  TypertRemoteContribution,
  TypertRemoteRegistry,
  TypertRegistryChange,
  TypertRegistryListener,
  TypertRegistryContract,
} from '@deepseek-ai/dsh-typert-protocol'
import type {
  TypertContribution,
  TypertFace,
  TypertPackageFilter,
  TypertPackageRecord,
  TypertSchemaFilter,
  TypertSchemaRecord,
} from './types.ts'

/**
 * Compose the global key of one generated schema.
 * @param packageName - contributing npm package.
 * @param name - schema export name.
 * @returns `<package>#<name>`.
 */
export function typertKey(packageName: string, name: string): string {
  return `${packageName}#${name}`
}

/**
 * Compose the identity of one package-face model.
 * @param packageName - contributing npm package.
 * @param face - independently compiled face.
 * @returns `<package>#<face>`.
 */
export function typertPackageKey(packageName: string, face: TypertFace): string {
  return `${packageName}#${face}`
}

/**
 * Compose the endpoint key used by local and Remote invocation registries.
 * @param descriptor - invocation whose namespace and method form the endpoint.
 * @returns `<namespace>/<method>`.
 */
export function typertEndpoint(descriptor: Pick<InvocationDescriptor, 'namespace' | 'method'>): string {
  return `${descriptor.namespace}/${descriptor.method}`
}

interface DescriptorEntry {
  readonly descriptor: InvocationDescriptor
  readonly owner: object
}

interface ProviderEntry<Provider> {
  readonly provider: Provider
  readonly owner: object
}

type ReportObserverError = (change: TypertRegistryChange, error: unknown) => void

class ChangeSource {
  private readonly listeners = new Set<TypertRegistryListener>()

  constructor(private readonly report: ReportObserverError) {}

  subscribe(ctx: Context, listener: TypertRegistryListener): TypertDisposer {
    const { listeners } = this
    return ctx.effect(function* () {
      listeners.add(listener)
      yield () => { listeners.delete(listener) }
    }, 'typert registry subscription')
  }

  emit(change: TypertRegistryChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change)
      } catch (error) {
        this.report(change, error)
      }
    }
  }
}

class DescriptorStore {
  private readonly entries = new Map<string, DescriptorEntry>()
  private readonly ids = new Map<string, DescriptorEntry>()
  private readonly history = new Set<string>()
  private readonly changes: ChangeSource

  constructor(
    private readonly kind: 'local' | 'remote',
    report: ReportObserverError,
  ) {
    this.changes = new ChangeSource(report)
  }

  validate(descriptors: readonly InvocationDescriptor[]): void {
    const endpoints = new Set<string>()
    const ids = new Set<string>()
    for (const descriptor of descriptors) {
      validateInvocation(descriptor)
      const endpoint = typertEndpoint(descriptor)
      if (endpoints.has(endpoint) || this.entries.has(endpoint)) {
        throw new Error(`typert: ${this.kind} endpoint "${endpoint}" is already registered`)
      }
      if (ids.has(descriptor.id) || this.ids.has(descriptor.id)) {
        throw new Error(`typert: ${this.kind} invocation id "${descriptor.id}" is already registered`)
      }
      endpoints.add(endpoint)
      ids.add(descriptor.id)
    }
  }

  commit(owner: object, descriptors: readonly InvocationDescriptor[]): void {
    for (const descriptor of descriptors) {
      const entry = { descriptor, owner }
      const endpoint = typertEndpoint(descriptor)
      this.entries.set(endpoint, entry)
      this.ids.set(descriptor.id, entry)
      this.history.add(endpoint)
    }
    for (const descriptor of descriptors) {
      this.changes.emit({ kind: this.kind, key: typertEndpoint(descriptor) })
    }
  }

  withdraw(owner: object, descriptors: readonly InvocationDescriptor[]): void {
    const removed: string[] = []
    for (const descriptor of descriptors) {
      const endpoint = typertEndpoint(descriptor)
      const entry = this.entries.get(endpoint)
      /* v8 ignore next -- duplicate registration is rejected, so no later owner can replace this entry before its effect disposes. */
      if (entry?.owner !== owner) continue
      this.entries.delete(endpoint)
      /* v8 ignore next -- ids and endpoints are committed and withdrawn together under the same unique owner. */
      if (this.ids.get(descriptor.id) === entry) this.ids.delete(descriptor.id)
      removed.push(endpoint)
    }
    for (const endpoint of removed) this.changes.emit({ kind: this.kind, key: endpoint })
  }

  get(endpoint: string): InvocationDescriptor | undefined {
    return this.entries.get(endpoint)?.descriptor
  }

  hasSeen(endpoint: string): boolean {
    return this.history.has(endpoint)
  }

  list(): readonly InvocationDescriptor[] {
    return [...this.entries.values()].map(entry => entry.descriptor)
  }

  subscribe(ctx: Context, listener: TypertRegistryListener): TypertDisposer {
    return this.changes.subscribe(ctx, listener)
  }
}

class RemoteStore {
  private readonly packages = new Map<string, object>()

  constructor(private readonly descriptors: DescriptorStore) {}

  view(ctx: Context): TypertRemoteRegistry {
    return {
      register: contribution => this.register(ctx, contribution),
      get: endpoint => this.descriptors.get(endpoint),
      list: () => this.descriptors.list(),
      subscribe: listener => this.descriptors.subscribe(ctx, listener),
    }
  }

  private register(ctx: Context, contribution: TypertRemoteContribution): TypertDisposer {
    validateSegment('Remote package name', contribution.package)
    if (this.packages.has(contribution.package)) {
      throw new Error(`typert: Remote package "${contribution.package}" is already registered`)
    }
    this.descriptors.validate(contribution.descriptors)
    const owner = {}
    const { packages, descriptors } = this
    return ctx.effect(function* () {
      packages.set(contribution.package, owner)
      descriptors.commit(owner, contribution.descriptors)
      yield () => {
        /* v8 ignore else -- duplicate package registration is rejected, so this effect remains the package's unique owner. */
        if (packages.get(contribution.package) === owner) packages.delete(contribution.package)
        descriptors.withdraw(owner, contribution.descriptors)
      }
    }, `typert.remotes.register(${JSON.stringify(contribution.package)})`)
  }
}

class LookupStore {
  private readonly providers = new Map<string, ProviderEntry<TypertLookupProvider>>()
  private readonly resolvers = new Map<string, ProviderEntry<LookupResolverEntry>>()
  private readonly definitions = new Map<string, TypertLookupDefinition>()
  private readonly changes: ChangeSource

  constructor(report: ReportObserverError) {
    this.changes = new ChangeSource(report)
  }

  view(ctx: Context): TypertLookupRegistry {
    return {
      register: <K extends Extract<keyof TypertLookupMap, string>>(
        key: K,
        provider: TypertLookupProvider<
          TypertLookupHost<TypertLookupMap[K]>,
          TypertLookupWire<TypertLookupMap[K]>
        >,
      ) => this.register(ctx, key, provider),
      configure: <K extends Extract<keyof TypertLookupMap, string>>(
        key: K,
        resolver: TypertLookupResolver<
          TypertLookupHost<TypertLookupMap[K]>,
          TypertLookupWire<TypertLookupMap[K]>
        >,
      ) => this.configure(ctx, key, resolver),
      get: key => this.get(key),
      definitions: () => [...this.definitions.values()],
      keys: () => [...this.providers.keys()],
      subscribe: listener => this.changes.subscribe(ctx, listener),
    }
  }

  private get(key: string): TypertLookupProvider | undefined {
    const provider = this.providers.get(key)?.provider
    if (provider === undefined) return undefined
    const resolver = this.resolvers.get(key)?.provider
    if (resolver === undefined) return provider
    return {
      parameter: provider.parameter,
      wire: provider.wire,
      hostTypeSymbol: provider.hostTypeSymbol,
      wireTypeSymbol: provider.wireTypeSymbol,
      resolve: id => resolver.resolve(id),
    }
  }

  private configure<Host, Wire>(
    ctx: Context,
    key: string,
    resolver: TypertLookupResolver<Host, Wire>,
  ): TypertDisposer {
    validateSegment('lookup key', key)
    if (this.resolvers.has(key)) throw new Error(`typert: lookup "${key}" resolver is already configured`)
    const owner = {}
    // The map erases each merge-declared Wire type; restore it only at the
    // typed configure() boundary so strict function variance remains sound.
    const entry: ProviderEntry<LookupResolverEntry> = {
      provider: { resolve: async id => resolver(id as Wire) },
      owner,
    }
    const { resolvers, changes } = this
    return ctx.effect(function* () {
      resolvers.set(key, entry)
      changes.emit({ kind: 'lookup', key })
      yield () => {
        /* v8 ignore next -- duplicate configuration is rejected, so this effect remains the key's unique owner. */
        if (resolvers.get(key) !== entry) return
        resolvers.delete(key)
        changes.emit({ kind: 'lookup', key })
      }
    }, `typert.lookups.configure(${JSON.stringify(key)})`)
  }

  private register<Host, Wire>(ctx: Context, key: string, provider: TypertLookupProvider<Host, Wire>): TypertDisposer {
    validateSegment('lookup key', key)
    validateSegment('lookup parameter', provider.parameter)
    validateWireName('lookup wire field', provider.wire)
    validateNonempty('lookup Host type symbol', provider.hostTypeSymbol)
    validateNonempty('lookup wire type symbol', provider.wireTypeSymbol)
    if (this.providers.has(key)) throw new Error(`typert: lookup "${key}" is already registered`)
    const definition: TypertLookupDefinition = {
      key,
      parameter: provider.parameter,
      wire: provider.wire,
      hostTypeSymbol: provider.hostTypeSymbol,
      wireTypeSymbol: provider.wireTypeSymbol,
    }
    const known = this.definitions.get(key)
    if (known !== undefined && !lookupDefinitionEquals(known, definition)) {
      throw new Error(`typert: lookup "${key}" changed its wire declaration during this registry lifetime`)
    }
    const owner = {}
    const entry: ProviderEntry<TypertLookupProvider> = { provider, owner }
    const { definitions, providers, changes } = this
    return ctx.effect(function* () {
      definitions.set(key, definition)
      providers.set(key, entry)
      changes.emit({ kind: 'lookup', key })
      yield () => {
        /* v8 ignore next -- duplicate registration is rejected, so this effect remains the key's unique owner. */
        if (providers.get(key) !== entry) return
        providers.delete(key)
        changes.emit({ kind: 'lookup', key })
      }
    }, `typert.lookups.register(${JSON.stringify(key)})`)
  }
}

interface LookupResolverEntry {
  resolve(id: unknown): Promise<unknown>
}

function lookupDefinitionEquals(left: TypertLookupDefinition, right: TypertLookupDefinition): boolean {
  return left.parameter === right.parameter
    && left.wire === right.wire
    && left.hostTypeSymbol === right.hostTypeSymbol
    && left.wireTypeSymbol === right.wireTypeSymbol
}

class ContextStore {
  private readonly hosts = new Map<string, ProviderEntry<TypertHostContextAdapter>>()
  private readonly hostResolvers = new Map<string, ProviderEntry<HostContextResolverEntry>>()
  private readonly clients = new Map<string, ProviderEntry<TypertClientContextAdapter>>()
  private readonly changes: ChangeSource

  constructor(report: ReportObserverError) {
    this.changes = new ChangeSource(report)
  }

  view(ctx: Context): TypertContextRegistry {
    return {
      registerHost: <K extends Extract<keyof TypertContextMap, string>>(
        key: K,
        adapter: TypertHostContextAdapter<TypertContextWire<TypertContextMap[K]>>,
      ) => this.registerHost(ctx, key, adapter),
      configureHost: <K extends Extract<keyof TypertContextMap, string>>(
        key: K,
        resolver: TypertHostContextResolver<TypertContextWire<TypertContextMap[K]>>,
      ) => this.configureHost(ctx, key, resolver),
      registerClient: <K extends Extract<keyof TypertContextMap, string>>(
        key: K,
        adapter: TypertClientContextAdapter<TypertContextWire<TypertContextMap[K]>>,
      ) => this.registerClient(ctx, key, adapter),
      getHost: key => this.getHost(key),
      getClient: key => this.clients.get(key)?.provider,
      subscribe: listener => this.changes.subscribe(ctx, listener),
    }
  }

  private getHost(key: string): TypertHostContextAdapter | undefined {
    const adapter = this.hosts.get(key)?.provider
    if (adapter === undefined) return undefined
    const resolver = this.hostResolvers.get(key)?.provider
    if (resolver === undefined) return adapter
    return {
      wire: adapter.wire,
      wireTypeSymbol: adapter.wireTypeSymbol,
      resolve: id => resolver.resolve(id),
    }
  }

  private configureHost<Wire>(
    ctx: Context,
    key: string,
    resolver: TypertHostContextResolver<Wire>,
  ): TypertDisposer {
    validateSegment('Context key', key)
    if (this.hostResolvers.has(key)) throw new Error(`typert: host-context "${key}" resolver is already configured`)
    const entry: ProviderEntry<HostContextResolverEntry> = {
      provider: { resolve: async id => resolver(id as Wire) },
      owner: {},
    }
    const { hostResolvers, changes } = this
    return ctx.effect(function* () {
      hostResolvers.set(key, entry)
      changes.emit({ kind: 'host-context', key })
      yield () => {
        /* v8 ignore next -- duplicate configuration is rejected, so this effect remains the key's unique owner. */
        if (hostResolvers.get(key) !== entry) return
        hostResolvers.delete(key)
        changes.emit({ kind: 'host-context', key })
      }
    }, `typert.contexts.configureHost(${JSON.stringify(key)})`)
  }

  private registerHost<Wire>(ctx: Context, key: string, adapter: TypertHostContextAdapter<Wire>): TypertDisposer {
    validateSegment('Context key', key)
    validateWireName('Context wire field', adapter.wire)
    validateNonempty('Context wire type symbol', adapter.wireTypeSymbol)
    return this.registerProvider(ctx, this.hosts, 'host-context', key, adapter)
  }

  private registerClient<Wire>(ctx: Context, key: string, adapter: TypertClientContextAdapter<Wire>): TypertDisposer {
    validateSegment('Context key', key)
    return this.registerProvider(ctx, this.clients, 'client-context', key, adapter)
  }

  private registerProvider<Provider>(
    ctx: Context,
    table: Map<string, ProviderEntry<Provider>>,
    kind: 'host-context' | 'client-context',
    key: string,
    provider: Provider,
  ): TypertDisposer {
    if (table.has(key)) throw new Error(`typert: ${kind} provider "${key}" is already registered`)
    const entry: ProviderEntry<Provider> = { provider, owner: {} }
    const { changes } = this
    return ctx.effect(function* () {
      table.set(key, entry)
      changes.emit({ kind, key })
      yield () => {
        /* v8 ignore next -- duplicate registration is rejected, so this effect remains the key's unique owner. */
        if (table.get(key) !== entry) return
        table.delete(key)
        changes.emit({ kind, key })
      }
    }, `typert.contexts.register(${JSON.stringify(key)})`)
  }
}

interface HostContextResolverEntry {
  resolve(id: unknown): Promise<Context | undefined>
}

/**
 * Registry of generated schemas, package reflection, invocations, and Remote
 * dependency providers.
 * @typert service typert
 */
export class TypertRegistry extends Service implements TypertRegistryContract {
  private readonly schemas = new Map<string, TypertSchemaRecord>()
  private readonly packages = new Map<string, TypertPackageRecord>()
  private readonly localStore: DescriptorStore
  private readonly remoteStore: RemoteStore
  private readonly lookupStore: LookupStore
  private readonly contextStore: ContextStore

  constructor(ctx: Context) {
    super(ctx, 'typert')
    const report: ReportObserverError = (change, error) => {
      ctx.logger.warn(`typert: ${change.kind} observer for "${change.key}" failed`)
      ctx.logger.warn(error)
    }
    this.localStore = new DescriptorStore('local', report)
    this.remoteStore = new RemoteStore(new DescriptorStore('remote', report))
    this.lookupStore = new LookupStore(report)
    this.contextStore = new ContextStore(report)
  }

  /** Current-environment invocation definitions. */
  get local(): TypertLocalRegistry {
    const ctx = this.ctx
    return {
      get: endpoint => this.localStore.get(endpoint),
      hasSeen: endpoint => this.localStore.hasSeen(endpoint),
      list: () => this.localStore.list(),
      subscribe: listener => this.localStore.subscribe(ctx, listener),
    }
  }

  /** Consumer-selected Remote definitions. */
  get remotes(): TypertRemoteRegistry {
    return this.remoteStore.view(this.ctx)
  }

  /** Host object lookup providers. */
  get lookups(): TypertLookupRegistry {
    return this.lookupStore.view(this.ctx)
  }

  /** Host and Client Context adapters. */
  get contexts(): TypertContextRegistry {
    return this.contextStore.view(this.ctx)
  }

  /**
   * Register one generated contribution atomically for the calling fiber.
   * Duplicate package-face identities, schemas, invocation ids, or endpoints
   * reject the whole batch.
   * @param contribution - generated schemas, reflection, and Host invocations.
   * @returns the exact effect disposer that removes this contribution.
   */
  register(contribution: TypertContribution): TypertDisposer {
    const packageRecord = this.validatePackage(contribution)
    const schemaRecords = this.validateSchemas(contribution)
    const invocations = contribution.invocations
    this.localStore.validate(invocations)
    const owner = {}
    const { schemas, packages, localStore } = this
    return this.ctx.effect(function* () {
      packages.set(packageRecord.key, packageRecord)
      for (const record of schemaRecords) schemas.set(record.key, record)
      localStore.commit(owner, invocations)
      yield () => {
        /* v8 ignore else -- duplicate package-face registration is rejected, so this effect remains its unique owner. */
        if (packages.get(packageRecord.key) === packageRecord) packages.delete(packageRecord.key)
        for (const record of schemaRecords) {
          /* v8 ignore else -- duplicate schema registration is rejected, so this contribution remains each record's unique owner. */
          if (schemas.get(record.key) === record) schemas.delete(record.key)
        }
        localStore.withdraw(owner, invocations)
      }
    }, 'typert.register()')
  }

  /**
   * Look up one schema by `<package>#<name>`.
   * @param key - global schema key.
   * @returns the live schema record, or `undefined` when absent.
   */
  get(key: string): TypertSchemaRecord | undefined {
    return this.schemas.get(key)
  }

  /**
   * Resolve one required schema.
   * @param key - global schema key.
   * @returns the live schema record.
   * @throws when the key is malformed, the package face is absent, or the schema is not contributed.
   */
  resolve(key: string): TypertSchemaRecord {
    const record = this.schemas.get(key)
    if (record !== undefined) return record
    const hash = key.indexOf('#')
    if (hash <= 0 || hash === key.length - 1) {
      throw new Error(`typert: invalid schema key "${key}" — expected "<package>#<name>"`)
    }
    const packageName = key.slice(0, hash)
    if ([...this.packages.values()].some(candidate => candidate.package === packageName)) {
      throw new Error(
        `typert: cannot resolve "${key}" — package "${packageName}" is registered but contributes no schema named "${key.slice(hash + 1)}"`,
      )
    }
    throw new Error(`typert: cannot resolve "${key}" — package "${packageName}" has no registered contribution`)
  }

  /**
   * Enumerate live schemas in registration order.
   * @param filter - optional package and face restriction.
   * @returns matching schema records.
   */
  list(filter: TypertSchemaFilter = {}): TypertSchemaRecord[] {
    return [...this.schemas.values()].filter(record => matches(record, filter))
  }

  /**
   * Look up generated reflection for one package face.
   * @param packageName - exact npm package name.
   * @param face - face to query; defaults to the host runtime.
   * @returns the live package record, or `undefined` when absent.
   */
  getPackage(packageName: string, face: TypertFace = 'host'): TypertPackageRecord | undefined {
    return this.packages.get(typertPackageKey(packageName, face))
  }

  /**
   * Enumerate generated package reflection in registration order.
   * @param filter - optional package and face restriction.
   * @returns matching package records.
   */
  listPackages(filter: TypertPackageFilter = {}): TypertPackageRecord[] {
    return [...this.packages.values()].filter(record => matches(record, filter))
  }

  /**
   * Project a live Zod schema to JSON Schema without caching the result.
   * @param key - global schema key.
   * @param params - Zod projection parameters.
   * @returns a fresh JSON Schema document.
   */
  toJSONSchema(key: string, params?: z.core.ToJSONSchemaParams): z.core.JSONSchema.BaseSchema {
    return z.toJSONSchema(this.resolve(key).schema, params)
  }

  private validatePackage(contribution: TypertContribution): TypertPackageRecord {
    validateSegment('package name', contribution.package)
    const face: unknown = contribution.face
    if (face !== 'host' && face !== 'client') {
      throw new Error(`typert: invalid face ${JSON.stringify(face)} — expected "host" or "client"`)
    }
    const key = typertPackageKey(contribution.package, contribution.face)
    if (this.packages.has(key)) {
      throw new Error(`typert: package face "${key}" is already registered`)
    }
    return {
      package: contribution.package,
      face,
      key,
      model: contribution.model,
    }
  }

  private validateSchemas(contribution: TypertContribution): TypertSchemaRecord[] {
    const records: TypertSchemaRecord[] = []
    const batch = new Set<string>()
    for (const schema of contribution.schemas) {
      validateSegment('schema name', schema.name)
      const key = typertKey(contribution.package, schema.name)
      if (batch.has(key) || this.schemas.has(key)) {
        throw new Error(`typert: schema "${key}" is already registered`)
      }
      batch.add(key)
      records.push({
        ...schema,
        package: contribution.package,
        face: contribution.face,
        key,
      })
    }
    return records
  }
}

function matches(
  record: { readonly package: string; readonly face: TypertFace },
  filter: { readonly package?: string; readonly face?: TypertFace },
): boolean {
  return (filter.package === undefined || record.package === filter.package)
    && (filter.face === undefined || record.face === filter.face)
}

function validateInvocation(descriptor: InvocationDescriptor): void {
  validateNonempty('invocation id', descriptor.id)
  validateSegment('invocation service key', descriptor.service)
  validateWireName('invocation namespace', descriptor.namespace)
  validateWireName('invocation method', descriptor.method)
  if (descriptor.implementation !== undefined) {
    validateWireName('invocation implementation method', descriptor.implementation)
  }
  validateCodec(descriptor.result, `${descriptor.id} result`)
  const wires = new Set<string>()
  for (const parameter of descriptor.parameters) {
    validateWireName('parameter name', parameter.name)
    validateWireName('parameter wire field', parameter.wire)
    if (wires.has(parameter.wire)) {
      throw new Error(`typert: invocation "${descriptor.id}" repeats wire field "${parameter.wire}"`)
    }
    wires.add(parameter.wire)
    if (parameter.source === 'lookup') {
      if (parameter.acceptsUndefined !== undefined) {
        throw new Error(`typert: invocation "${descriptor.id}" lookup parameter "${parameter.name}" cannot accept undefined`)
      }
      if (parameter.lookup === undefined) {
        throw new Error(`typert: invocation "${descriptor.id}" lookup parameter "${parameter.name}" has no lookup key`)
      }
      validateSegment('lookup key', parameter.lookup)
    } else if (parameter.lookup !== undefined) {
      throw new Error(`typert: invocation "${descriptor.id}" JSON parameter "${parameter.name}" declares a lookup key`)
    }
    validateCodec(parameter.codec, `${descriptor.id} parameter ${parameter.name}`)
  }
  const cancellation = descriptor.cancellation as { readonly parameter: string } | undefined
  if (cancellation !== undefined && cancellation.parameter !== 'signal') {
    throw new Error(`typert: invocation "${descriptor.id}" cancellation parameter must be "signal"`)
  }
  if (descriptor.scope !== undefined) {
    if (descriptor.invocation.kind !== 'direct') {
      throw new Error(`typert: invocation "${descriptor.id}" Context receiver cannot declare a direct scope projection`)
    }
    validateSegment('scope Context key', descriptor.scope.context)
    validateWireName('scope wire field', descriptor.scope.wire)
    const lookups = descriptor.parameters.filter(candidate => candidate.source === 'lookup')
    const parameter = lookups.length === 1 ? lookups[0] : undefined
    if (parameter === undefined || parameter.wire !== descriptor.scope.wire
      || parameter.lookup !== descriptor.scope.context) {
      throw new Error(
        `typert: invocation "${descriptor.id}" scope wire "${descriptor.scope.wire}" must select its only lookup parameter`,
      )
    }
  }
  if (descriptor.invocation.kind === 'context') {
    validateSegment('Context key', descriptor.invocation.context)
    validateWireName('Context wire field', descriptor.invocation.wire)
    if (wires.has(descriptor.invocation.wire)) {
      throw new Error(`typert: invocation "${descriptor.id}" repeats wire field "${descriptor.invocation.wire}"`)
    }
    validateCodec(descriptor.invocation.codec, `${descriptor.id} Context`)
  }
}

function validateCodec(codec: InvocationDescriptor['result'], subject: string): void {
  if (codec.mode === 'src-json') return
  validateNonempty(`${subject} type symbol`, codec.typeSymbol)
  if (typeof codec.schema.parse !== 'function') {
    throw new Error(`typert: ${subject} strict codec has no parse() method`)
  }
}

function validateWireName(subject: string, value: string): void {
  if (value === '.' || value === '..' || !/^[A-Za-z0-9_$.-]+$/.test(value)) {
    throw new Error(`typert: invalid ${subject} "${value}" — must contain only RPC endpoint segment characters`)
  }
}

function validateSegment(subject: string, value: string): void {
  if (value.length === 0 || value.includes('#')) {
    throw new Error(`typert: invalid ${subject} "${value}" — must be nonempty and must not contain "#"`)
  }
}

function validateNonempty(subject: string, value: string): void {
  if (value.length === 0) throw new Error(`typert: invalid ${subject} — must be nonempty`)
}

export default TypertRegistry
