/**
 * Parent-owned durable subagent catalog events and their chunked projection.
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
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import type { SubagentCatalogEntry } from './projection-types.ts'

/** Catalog payload version emitted by live child creation. */
export const SUBAGENT_CATALOG_VERSION = 0

type KnownCatalogMode =
  | { readonly mode: 'one-shot'; readonly label?: string }
  | { readonly mode: 'continuable'; readonly label: string }

/** Parent catalog v0 records known modes; v1 also retains children with unknown mode. */
export type SubagentCatalogEvent =
  & {
    readonly childId: SessionId
    readonly childCreatedAt: number
  } & (
    | ({ readonly version: 0 } & KnownCatalogMode)
    | ({ readonly version: 1 } & (KnownCatalogMode | { readonly mode: 'unknown'; readonly label?: string }))
  )

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * A direct child's identity and available discovery fields.
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
  childId: sessionIdSchema,
  childCreatedAt: z.number().int().nonnegative(),
  mode: z.literal('one-shot'),
  label: z.string().optional(),
}).strict()
const continuableCatalogSchema = z.object({
  version: z.union([z.literal(0), z.literal(1)]),
  childId: sessionIdSchema,
  childCreatedAt: z.number().int().nonnegative(),
  mode: z.literal('continuable'),
  label: z.string(),
}).strict()
const unknownCatalogSchema = oneShotCatalogSchema.extend({ version: z.literal(1), mode: z.literal('unknown') })
const eventDataSchema = z.union([
  oneShotCatalogSchema,
  continuableCatalogSchema,
  unknownCatalogSchema,
]) as z.ZodType<SubagentCatalogEvent>
const viewSchema = z.array(z.union([
  oneShotCatalogSchema.omit({ version: true, childId: true, childCreatedAt: true }).extend({
    id: sessionIdSchema,
    createdAt: oneShotCatalogSchema.shape.childCreatedAt,
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
    entries.push(data.mode !== 'continuable'
      ? {
        id: data.childId,
        createdAt: data.childCreatedAt,
        mode: data.mode,
        ...data.label === undefined ? {} : { label: data.label },
      }
      : {
        id: data.childId,
        createdAt: data.childCreatedAt,
        mode: data.mode,
        label: data.label,
      })
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
  stateVersion: 3,
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
  descriptor:
    | { readonly mode: 'one-shot'; readonly label?: string }
    | { readonly mode: 'continuable'; readonly label: string },
): void {
  parent.append('subagent/catalog', descriptor.mode === 'one-shot'
    ? {
      version: SUBAGENT_CATALOG_VERSION,
      childId: child.id,
      childCreatedAt: child.createdAt,
      mode: descriptor.mode,
      ...descriptor.label === undefined ? {} : { label: descriptor.label },
    }
    : {
      version: SUBAGENT_CATALOG_VERSION,
      childId: child.id,
      childCreatedAt: child.createdAt,
      mode: descriptor.mode,
      label: descriptor.label,
    })
}
