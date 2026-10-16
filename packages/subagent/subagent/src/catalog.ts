/**
 * Durable child discovery and root name registrations in one catalog projection.
 *
 * @module @deepseek-ai/dsh-subagent/catalog
 */

import { z } from 'zod'
import { appendChunkedList, chunkedListSchema, iterateChunkedList } from '@deepseek-ai/dsh-chunked-list'
import type { ChunkedList } from '@deepseek-ai/dsh-chunked-list'
import type {
  Session,
  SessionEvent,
  SessionHeader,
  SessionId,
  SessionLogOffset,
} from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition, SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import type { SubagentCatalogEntry } from './projection-types.ts'
import { subagentNameSchema } from './descriptor.ts'
import { SubagentError } from './error.ts'

/** Catalog payload version emitted by local child creation. */
export const SUBAGENT_CATALOG_VERSION = 0

type KnownCatalogMode =
  | { readonly mode: 'one-shot'; readonly label?: string }
  | { readonly mode: 'continuable'; readonly label: string }

/** Child discovery records: v0 local modes, v1 unknown children, and v2 external executions. */
type CatalogChildEvent =
  & {
    /** Immutable tree-wide name; absent in older catalogs. */
    readonly name?: string
    readonly childId: SessionId
    readonly childCreatedAt: number
  } & (
    | ({ readonly version: 0 } & KnownCatalogMode)
    | ({ readonly version: 1 } & (KnownCatalogMode | { readonly mode: 'unknown'; readonly label?: string }))
    | { readonly version: 2; readonly mode: 'external'; readonly label?: string }
  )

/** Catalog v3 registers a descendant name in the tree root without adding a direct child. */
export type SubagentCatalogEvent = CatalogChildEvent | {
  readonly version: 3
  readonly kind: 'name'
  readonly childId: SessionId
  readonly name: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Direct-child discovery or a root-owned descendant name registration.
     * @param data - versioned parent-owned catalog entry.
     */
    'subagent/catalog': SubagentCatalogEvent
  }
}

/** Host fold state for one parent catalog. */
export interface SubagentCatalogState {
  readonly inheritedEventCount: SessionLogOffset
  readonly head?: ChunkedList<SubagentCatalogEvent> | undefined
}

const sessionIdSchema = z.string() as unknown as z.ZodType<SessionId>
const oneShotCatalogSchema = z.object({
  version: z.union([z.literal(0), z.literal(1)]),
  name: subagentNameSchema.optional(),
  childId: sessionIdSchema,
  childCreatedAt: z.number().int().nonnegative(),
  mode: z.literal('one-shot'),
  label: z.string().optional(),
}).strict()
const continuableCatalogSchema = z.object({
  version: z.union([z.literal(0), z.literal(1)]),
  name: subagentNameSchema.optional(),
  childId: sessionIdSchema,
  childCreatedAt: z.number().int().nonnegative(),
  mode: z.literal('continuable'),
  label: z.string(),
}).strict()
const externalCatalogSchema = oneShotCatalogSchema.extend({ version: z.literal(2), mode: z.literal('external') })
const unknownCatalogSchema = oneShotCatalogSchema.extend({ version: z.literal(1), mode: z.literal('unknown') })
const eventDataSchema = z.union([
  oneShotCatalogSchema,
  externalCatalogSchema,
  continuableCatalogSchema,
  unknownCatalogSchema,
  z.object({ version: z.literal(3), kind: z.literal('name'), childId: sessionIdSchema, name: subagentNameSchema }).strict(),
]) as z.ZodType<SubagentCatalogEvent>
const viewSchema = z.array(z.union([
  oneShotCatalogSchema.omit({ version: true, childId: true, childCreatedAt: true }).extend({
    id: sessionIdSchema,
    createdAt: oneShotCatalogSchema.shape.childCreatedAt,
  }),
  externalCatalogSchema.omit({ version: true, childId: true, childCreatedAt: true }).extend({
    id: sessionIdSchema,
    createdAt: externalCatalogSchema.shape.childCreatedAt,
  }),
  continuableCatalogSchema.omit({ version: true, childId: true, childCreatedAt: true }).extend({
    id: sessionIdSchema,
    createdAt: continuableCatalogSchema.shape.childCreatedAt,
  }),
  unknownCatalogSchema.omit({ version: true, childId: true, childCreatedAt: true }).extend({
    id: sessionIdSchema,
    createdAt: unknownCatalogSchema.shape.childCreatedAt,
  }),
])) as z.ZodType<SubagentCatalogEntry[]>
const stateSchema: z.ZodType<SubagentCatalogState> = z.object({
  inheritedEventCount: z.number().int().nonnegative() as unknown as z.ZodType<SessionLogOffset>,
  head: chunkedListSchema(eventDataSchema).optional(),
}).strict()

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    subagentCatalog: SubagentCatalogState
  }
}

/**
 * Materialize complete and unknown-mode child identities from parent catalog events.
 * @param state - parent catalog fold state.
 * @returns current direct-child rows in parent catalog event order.
 */
function subagentCatalogEntries(state: SubagentCatalogState): SubagentCatalogEntry[] {
  const entries: SubagentCatalogEntry[] = []
  for (const data of iterateChunkedList(state.head)) {
    if (data.version === 3) continue
    const { version: _version, childId, childCreatedAt, ...descriptor } = data
    entries.push({ id: childId, createdAt: childCreatedAt, ...descriptor })
  }
  return entries
}

/** Parent-owned direct-child catalog projection; invalid own facts reject restoration. */
export const subagentCatalogProjectionDefinition = {
  key: 'subagentCatalog',
  stateSchema,
  init: (_header: SessionHeader, inheritedEventCount: SessionLogOffset) => ({ inheritedEventCount }),
  apply: (state, event: SessionEvent) => {
    if (event.type !== 'subagent/catalog' || event.seq < state.inheritedEventCount) return state
    return { ...state, head: appendChunkedList(state.head, eventDataSchema.parse(event.data)) }
  },
  stateVersion: 8,
  wire: { viewSchema, view: subagentCatalogEntries },
} satisfies ProjectionDefinition<'subagentCatalog', SubagentCatalogState>

/**
 * Append a complete direct-child discovery fact to its parent Session.
 * @param parent - durable direct parent receiving the discovery fact.
 * @param child - established child's immutable Session metadata.
 * @param descriptor - mode-discriminated creation label frozen with the child.
 */
export function establishCatalogChild(
  parent: Session,
  child: SessionHeader,
  descriptor: { readonly mode: 'continuable'; readonly label: string; readonly name?: string },
): void {
  parent.append('subagent/catalog', {
    version: SUBAGENT_CATALOG_VERSION,
    childId: child.id,
    childCreatedAt: child.createdAt,
    mode: descriptor.mode,
    label: descriptor.label,
    ...descriptor.name === undefined ? {} : { name: descriptor.name },
  })
}

/** Catalog payload version emitted by external execution creation. */
const EXTERNAL_SUBAGENT_CATALOG_VERSION = 2

/**
 * Record an external execution without a local child Session.
 * @param parent - durable direct parent receiving the discovery fact.
 * @param childId - identity returned by the external provider.
 * @param label - display label assigned by the caller.
 * @param name - immutable tree-wide name assigned at creation.
 */
export function establishExternalCatalogChild(parent: Session, childId: SessionId, label: string, name: string): void {
  parent.append('subagent/catalog', {
    version: EXTERNAL_SUBAGENT_CATALOG_VERSION,
    childId,
    childCreatedAt: Date.now(),
    mode: 'external',
    label,
    name,
  })
}

/**
 * Read the current catalog rows of one live parent Session.
 * @param projections - Session projection registry owning the catalog unit, when composed.
 * @param parent - live parent Session whose own catalog facts are read.
 * @returns direct-child rows in catalog event order.
 * @throws {SubagentError} `CONTINUATION_UNAVAILABLE` when the catalog projection is not registered.
 */
export function liveCatalogEntries(
  projections: SessionProjectionRegistry | undefined,
  parent: Session,
): SubagentCatalogEntry[] {
  return subagentCatalogEntries(liveCatalogState(projections, parent))
}

/**
 * Read root catalog assignments, including legacy addresses for unnamed direct children.
 * @param state - root Session's own catalog state.
 * @param rootId - root identity reserved for lead.
 * @returns immutable name-to-child assignments; incomplete descendant rows live only in their parent.
 * @throws {SubagentError} when persisted names or child identities conflict.
 */
export function catalogNames(state: SubagentCatalogState, rootId: SessionId): ReadonlyMap<string, SessionId> {
  const names = new Map<string, SessionId>()
  const ids = new Set<SessionId>([rootId])
  for (const entry of iterateChunkedList(state.head)) {
    const name = entry.name ?? `legacy:${entry.childId}`
    if (names.get(name) === entry.childId) continue
    if (names.has(name) || ids.has(entry.childId)) {
      throw new SubagentError('duplicate cataloged agent name or identity; restore the root catalog', 'CORRUPT_AGENT_NAMES')
    }
    names.set(name, entry.childId)
    ids.add(entry.childId)
  }
  return names
}

/**
 * Read one live Session's catalog fold, including root name registrations.
 * @param projections - registry owning the catalog projection.
 * @param session - exact live Session to read.
 * @returns catalog state for the Session's own suffix.
 */
export function liveCatalogState(projections: SessionProjectionRegistry | undefined, session: Session): SubagentCatalogState {
  const state = projections?.stateOf(session, 'subagentCatalog')
  if (state === undefined) {
    throw new SubagentError('subagent naming and discovery require the subagentCatalog projection', 'CONTINUATION_UNAVAILABLE')
  }
  return state
}
