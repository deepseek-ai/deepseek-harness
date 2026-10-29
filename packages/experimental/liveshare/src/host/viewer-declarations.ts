/**
 * Temporary: the Remote endpoints plugins offer to share viewers.
 *
 * A plugin that owns an endpoint the served viewer page needs declares it here, because the `share-viewer`
 * policy decides every viewer call and enumerates only the core endpoints. **A declaration is an offer, not
 * a grant**: it says the plugin asserts the endpoint may be called from a share, and grants nothing by
 * itself. The owner exposes it by selecting that plugin's endpoint in one share, and only the intersection
 * of the live declarations with one share's own selection reaches that share's viewers.
 *
 * This surface is **temporary**: it is replaced by endpoint-level access declarations in Typert metadata,
 * and it is deleted once that metadata names each endpoint's access class; do not build a long-term
 * integration on it.
 *
 * The service carries no `Context` key of its own, so a plugin reads it through
 * {@link viewerDeclarationsOf}, which preserves the calling context; the lookup is untyped by
 * construction, so the accessor narrows the value it finds.
 * @module @deepseek-ai/dsh-experimental-liveshare/src/host/viewer-declarations
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { isTypertRemoteSegment, type InvocationDescriptor } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteAccessEndpoint } from '@deepseek-ai/dsh-api-remote-access/types'

/**
 * Name the capability service is provided under. Deliberately not a `Context` key: a key would enter the
 * generated Cordis API catalog, whose partitions this change must not touch.
 */
export const VIEWER_DECLARATIONS_SERVICE = 'liveshareViewerDeclarations'

/** One plugin's endpoints of each kind, in the shape the share panel and the share record both use. */
export interface ViewerCapabilityGroup {
  /** Owning npm package of the declaring plugin, shown beside each choice. */
  readonly plugin: string
  /** Readable endpoints of that plugin, sorted. */
  readonly readable: readonly RemoteAccessEndpoint[]
  /** Writable endpoints of that plugin, sorted. */
  readonly writable: readonly RemoteAccessEndpoint[]
}

/** The endpoint kinds one declaration can offer. */
type CapabilityKind = 'readable' | 'writable'

/** What one declaration kind is called in its failure message. */
type DeclarationKind = 'viewer-readable' | 'viewer-writable'

/**
 * The declaration surface as a consumer reads it: the operations a provider must offer.
 *
 * Consumers narrow the service values they find structurally rather than by `ViewerDeclarations` class
 * identity, because the Loader instantiates a module once per entry: the entry that provides the surface and
 * the entry that mounts the share host hold different classes for the same value, and `instanceof` refuses
 * the provider's own instance.
 */
export interface ViewerDeclarationsSurface {
  /** Offer endpoints that change nothing; see {@link ViewerDeclarations.registerViewerReadable}. */
  registerViewerReadable(actions: readonly string[]): () => void
  /** Offer endpoints that write; see {@link ViewerDeclarations.registerViewerWritable}. */
  registerViewerWritable(actions: readonly string[]): () => void
  /** Observe every change to the offered set; see {@link ViewerDeclarations.onChanged}. */
  onChanged(listener: () => void): () => void
  /** The endpoints plugins currently offer; see {@link ViewerDeclarations.declaredCapabilities}. */
  declaredCapabilities(): readonly ViewerCapabilityGroup[]
}

/**
 * Test one service value for the whole declaration surface.
 * @param value - Value found under the service key.
 * @returns Whether every method of {@link ViewerDeclarationsSurface} is callable.
 */
function isViewerDeclarationsSurface(value: unknown): value is ViewerDeclarationsSurface {
  if (typeof value !== 'object' || value === null) return false
  const surface = value as Partial<Record<keyof ViewerDeclarationsSurface, unknown>>
  return typeof surface.registerViewerReadable === 'function'
    && typeof surface.registerViewerWritable === 'function'
    && typeof surface.onChanged === 'function'
    && typeof surface.declaredCapabilities === 'function'
}

/**
 * Test one plugin-authored name against the Remote endpoint grammar.
 *
 * The `<namespace>/<method>` template type admits names this grammar rejects — an empty segment, a third
 * segment, an `event:` prefix, or whitespace — and plugin names cross a package boundary, so the grammar
 * is checked here.
 * @param action - Candidate endpoint name.
 * @returns Whether the name is exactly two Remote name segments.
 */
function isDeclaredEndpoint(action: string): action is RemoteAccessEndpoint {
  const segments = action.split('/')
  if (segments.length !== 2) return false
  const [namespace, method] = segments
  return namespace !== undefined && method !== undefined
    && isTypertRemoteSegment(namespace) && isTypertRemoteSegment(method)
}

/**
 * Accept every name of one declaration, or none of them.
 * @param actions - The names one declaration carries.
 * @param kind - Declaration kind named in the failure message.
 * @returns The accepted names, in declaration order and without duplicates.
 * @throws {TypeError} When one name is not a `<namespace>/<method>` Remote endpoint; no name registers.
 */
function acceptedEndpoints(actions: readonly string[], kind: DeclarationKind): RemoteAccessEndpoint[] {
  const accepted = new Set<RemoteAccessEndpoint>()
  for (const action of actions) {
    if (!isDeclaredEndpoint(action)) {
      throw new TypeError(
        `liveshare: ${kind} endpoint ${JSON.stringify(action)} must be a <namespace>/<method> Remote endpoint`)
    }
    accepted.add(action)
  }
  return [...accepted]
}

/**
 * Read the owning package out of one live endpoint's generated identity.
 *
 * A generated invocation id is `<package>#<namespace>/<method>`, so the text before the endpoint's own
 * suffix names the package whose artifact defined it. An identity of any other form has no owner this check
 * can trust, so it refuses instead of guessing.
 * @param descriptor - Live Host invocation definition.
 * @param endpoint - The endpoint the declaration named.
 * @returns The owning package, or undefined when the identity does not end in `#<endpoint>`.
 */
function owningPackageOf(descriptor: InvocationDescriptor, endpoint: RemoteAccessEndpoint): string | undefined {
  const suffix = `#${endpoint}`
  if (!descriptor.id.endsWith(suffix)) return undefined
  const owner = descriptor.id.slice(0, -suffix.length)
  return owner === '' ? undefined : owner
}

/**
 * Accept one declaration only from the package that owns every endpoint it names.
 *
 * The declaring package is the Loader entry's module name, which the Loader owns and a plugin cannot
 * report; `ctx.fiber.name` is a display name shared by a plugin's nested mounts and is deliberately not
 * used here. Ownership is read from the Host's local Typert registry, the same definitions the Gateway
 * dispatches, so an endpoint that exists only in a plugin's source cannot be declared.
 *
 * Fail-closed: an endpoint the local registry does not define, a declaring fiber with no Loader entry, a
 * generated identity that does not name an owner, and an owner mismatch each refuse the whole declaration
 * with the reason that refused it. Two compositions therefore cannot declare viewer endpoints: a
 * programmatic `ctx.plugin()` composition has no Loader entry, and a nested or aliased entry's
 * `options.name` is the specifier of the entry that mounted it, which need not equal the npm package name
 * of the plugin's own package.
 * @param caller - The declaring plugin's context; its fiber carries the Loader entry name.
 * @param actions - Endpoints the declaration carries, already syntax-checked.
 * @param label - Declaration kind named in the failure message.
 * @returns The verified owning package, recorded as the offer's attribution.
 * @throws {TypeError} When one endpoint is not a live Host endpoint, the declaring fiber has no Loader entry
 *   name, its identity names no owner, or the owner is another package; no endpoint of the declaration
 *   registers.
 */
function declaringPackage(caller: Context, actions: readonly RemoteAccessEndpoint[], label: DeclarationKind): string {
  const declaring = caller.fiber.entry?.options.name
  if (declaring === undefined) {
    throw new TypeError(
      `liveshare: ${label} endpoints ${JSON.stringify(actions)} have no declaring package: `
      + 'the plugin has no Loader entry name, which a programmatic ctx.plugin() composition cannot supply')
  }
  const local = caller.get('typert')?.local
  for (const action of actions) {
    const descriptor = local?.get(action)
    if (descriptor === undefined) {
      throw new TypeError(
        `liveshare: ${label} endpoint ${JSON.stringify(action)} is not a live Host Remote endpoint `
        + '(declare it after the owning package\'s Typert artifact has registered)')
    }
    const owner = owningPackageOf(descriptor, action)
    if (owner === undefined) {
      throw new TypeError(
        `liveshare: ${label} endpoint ${JSON.stringify(action)} has generated id `
        + `${JSON.stringify(descriptor.id)}, which does not name an owning package`)
    }
    if (owner !== declaring) {
      throw new TypeError(
        `liveshare: ${label} endpoint ${JSON.stringify(action)} belongs to package ${JSON.stringify(owner)}, `
        + `not to the declaring package ${JSON.stringify(declaring)}`)
    }
  }
  return declaring
}

/**
 * Temporary: the endpoints plugins offer to share viewers.
 *
 * A declaration is checked before it is accepted: every endpoint must be a live Host Remote definition
 * owned by the declaring plugin's own package (see {@link declaringPackage}). The declaring plugin owns
 * the endpoint's confinement, because a declared endpoint's arguments arrive from an untrusted viewer; no
 * argument may be treated as authority.
 *
 * A declaration is an offer: the owner exposes an offered endpoint per share, and a declaration on its own
 * grants no viewer anything. Registration is a Cordis effect of the CALLER's fiber: read the service
 * through {@link viewerDeclarationsOf} so that Cordis traces the calling context. Disposing the declaring
 * plugin, or calling the returned disposer, withdraws exactly the names that call registered, and a share
 * whose owner selected one of them stops exposing it on the next decision. A name declared more than once
 * stays offered until the last registration naming it is disposed.
 *
 * The Liveshare bundle provides this service in its own load phase, before the share host — which waits for
 * a Relay connection — starts, so a plugin that offers endpoints at its own load time finds it. The share
 * host is one consumer: it reads the same service and subscribes through {@link onChanged}.
 *
 * The endpoints a declaration names are the Host's local Typert registrations. typert-loader registers a
 * package's artifact asynchronously, so an offer made from the package's own load body runs before its
 * endpoints exist; a plugin in that position must declare once its package's artifact is registered.
 */
export class ViewerDeclarations extends Service implements ViewerDeclarationsSurface {
  /** Live readable declarations: endpoint → owning package → live registrations. */
  private readonly readable = new Map<RemoteAccessEndpoint, Map<string, number>>()
  /** Live writable declarations, keyed the same way. */
  private readonly writable = new Map<RemoteAccessEndpoint, Map<string, number>>()
  /** Live change listeners, called after every registration and disposal. */
  private readonly changed = new Set<() => void>()

  /**
   * Provide the capability surface on `ctx`.
   * @param ctx - Context that provides the service; the service goes away with its fiber.
   */
  constructor(ctx: Context) {
    super(ctx, VIEWER_DECLARATIONS_SERVICE)
  }

  /**
   * Observe every change to the offered set.
   *
   * A consumer that derives decisions from {@link declaredCapabilities} recomputes them here; a listener
   * registered after a declaration still receives every later change. Bind the returned disposer to the
   * subscriber's own fiber so the listener goes away with it.
   * @param listener - Called after each registration and disposal that changed the offered set.
   * @returns Disposer removing this listener.
   */
  onChanged(listener: () => void): () => void {
    this.changed.add(listener)
    return () => { this.changed.delete(listener) }
  }

  /** Tell every live listener that the offered set may have changed. */
  private notifyChanged(): void {
    for (const listener of [...this.changed]) listener()
  }

  /**
   * Temporary: lets a plugin declare endpoints it asserts are read-only and safe to expose to any
   * authenticated share viewer. Superseded by endpoint-level access declarations in Typert metadata,
   * and this surface is deleted once they land; do not build a long-term integration on it.
   *
   * The assertion covers three obligations: the endpoint changes no Host state; it starts no work, sends
   * nothing, and schedules nothing; and any authenticated share viewer may call it on the resources the
   * share exposes. **This call is an offer and grants nothing**: the owner must select the endpoint in one
   * share before that share's viewers may call it.
   * @param actions - Endpoint names, each `<namespace>/<method>`.
   * @returns Disposer withdrawing the names this call registered.
   * @throws {TypeError} When a name is not a `<namespace>/<method>` Remote endpoint, the Host does not
   *   define it, or the declaring package does not own it; no name registers.
   */
  registerViewerReadable(actions: readonly string[]): () => void {
    return this.declare(this.readable, this.ctx, 'readable', actions, 'viewer-readable')
  }

  /**
   * Temporary: lets a plugin declare endpoints it asserts are safe to invoke from a share **whose session
   * mode already allows writes**. Superseded by endpoint-level access declarations in Typert metadata,
   * and this surface is deleted once they land; do not build a long-term integration on it.
   *
   * **This call is an offer and grants nothing, and it never escalates a read-only share.** A writable
   * endpoint is exposed only when the owner also selects it for that share, and the owner states consent
   * for writes only through the share's session mode, so a `view` share refuses it
   * whether it is declared and selected or not. A declared write endpoint runs on the owner's machine, so
   * the plugin owns its confinement.
   * @param actions - Endpoint names, each `<namespace>/<method>`.
   * @returns Disposer withdrawing the names this call registered.
   * @throws {TypeError} When a name is not a `<namespace>/<method>` Remote endpoint, the Host does not
   *   define it, or the declaring package does not own it; no name registers.
   */
  registerViewerWritable(actions: readonly string[]): () => void {
    return this.declare(this.writable, this.ctx, 'writable', actions, 'viewer-writable')
  }

  /**
   * The endpoints plugins currently offer, grouped by owning package and sorted.
   *
   * This is the offer list the share panel presents; it is not what any share exposes.
   * @returns One group per owning package with at least one live declaration.
   */
  declaredCapabilities(): readonly ViewerCapabilityGroup[] {
    const plugins = new Map<string, { readable: Set<RemoteAccessEndpoint>; writable: Set<RemoteAccessEndpoint> }>()
    for (const [kind, declared] of [['readable', this.readable], ['writable', this.writable]] as const) {
      for (const [action, byPlugin] of declared) {
        for (const plugin of byPlugin.keys()) {
          const group = plugins.get(plugin) ?? { readable: new Set(), writable: new Set() }
          group[kind].add(action)
          plugins.set(plugin, group)
        }
      }
    }
    return [...plugins]
      .map(([plugin, group]) => ({
        plugin,
        readable: [...group.readable].sort(),
        writable: [...group.writable].sort(),
      }))
      .sort((left, right) => left.plugin.localeCompare(right.plugin))
  }

  /**
   * Register one declaration kind as an effect of `caller`, the declaring plugin's own context.
   * @param declared - Live declarations of that kind.
   * @param caller - Context the effect binds to; the caller's context, not the share host's.
   * @param kind - Endpoint kind the declaration offers.
   * @param actions - Endpoint names the declaration carries.
   * @param label - Declaration kind named in the failure message.
   * @returns Disposer withdrawing the names this call registered.
   * @throws {TypeError} When a name is not a `<namespace>/<method>` Remote endpoint, the Host does not
   *   define it, or the declaring package does not own it; no name registers.
   */
  private declare(
    declared: Map<RemoteAccessEndpoint, Map<string, number>>,
    caller: Context,
    kind: CapabilityKind,
    actions: readonly string[],
    label: DeclarationKind,
  ): () => void {
    const accepted = acceptedEndpoints(actions, label)
    if (accepted.length === 0) return () => {}
    // Attribution is the verified owning package, so the panel groups by what the Host compiled, not by a
    // display name a plugin could choose.
    const plugin = declaringPackage(caller, accepted, label)
    const dispose = caller.effect(() => {
      for (const action of accepted) {
        const byPlugin = declared.get(action) ?? new Map<string, number>()
        byPlugin.set(plugin, (byPlugin.get(plugin) ?? 0) + 1)
        declared.set(action, byPlugin)
      }
      this.notifyChanged()
      return () => {
        for (const action of accepted) {
          const byPlugin = declared.get(action)
          // This effect registered each accepted name once, so its own disposer always finds its
          // entry and its count; the two guards below only satisfy lookups typed as optional.
          /* v8 ignore next -- repeated withdrawal is not a state this effect can reach. */
          if (byPlugin === undefined) continue
          /* v8 ignore next -- the count cannot be absent for a registration this effect made. */
          const remaining = (byPlugin.get(plugin) ?? 1) - 1
          if (remaining > 0) byPlugin.set(plugin, remaining)
          else byPlugin.delete(plugin)
          if (byPlugin.size === 0) declared.delete(action)
        }
        this.notifyChanged()
      }
    }, `liveshare.viewer-${kind}(${JSON.stringify(accepted)})`)
    return () => { void dispose() }
  }
}

/**
 * Temporary: the capability surface of an application that mounts the Liveshare bundle.
 *
 * The lookup is deliberately untyped — the service declares no `Context` key, because such a key would
 * have to enter the generated Cordis API catalog — so this accessor is the single narrowing point. It
 * accepts any value that carries the whole {@link ViewerDeclarationsSurface}, so a provider reached through
 * another Loader entry is read as the surface it is.
 * @param ctx - Context in the application that may mount the bundle.
 * @returns The capability surface, or undefined when this application mounts no Liveshare bundle.
 */
export function viewerDeclarationsOf(ctx: Context): ViewerDeclarationsSurface | undefined {
  const found: unknown = ctx.get(VIEWER_DECLARATIONS_SERVICE)
  return isViewerDeclarationsSurface(found) ? found : undefined
}
