/**
 * The viewer composer's model seat: the Session's model and reasoning effort, stated and not selectable.
 *
 * The served page renders the owner's Session, so the model it runs on and the reasoning effort it
 * asks for are facts about that Session rather than choices for the reader. This seat fills the
 * composer's own model position — where a DSH user looks for it — with that model's name, or its id
 * before the catalog arrives, and with the effort the next request would use. It renders through
 * {@link ViewerSeat}, whose `readOnly` switch is what keeps it a label.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-model
 */

import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { ViewerSeat, VIEWER_SEAT_PRIORITY } from './viewer-seat.tsx'

export const name = 'liveshare-viewer-model'

/** Composer slot registry, the Session list, and the Remote face the model catalog comes from. */
export const inject: readonly string[] = ['slots', 'sessions', 'remote', 'remote.session']

/** One exact model route, as the Session's own selection fold states it. */
interface StatedModel {
  readonly provider: string
  readonly model: string
  /** Reasoning effort the next request would use; absent when the Session states none. */
  readonly reasoningEffort?: string
}

/** The durable selection fold: what the last request used and what the next one would use. */
interface SelectionFold {
  readonly lastUsed: StatedModel | null
  readonly next: StatedModel | null
}

/** One effort level an adapter advertises for an exact model route. */
interface CatalogEffort {
  readonly id: string
  readonly name: string
}

/** Selectable reasoning metadata one catalog entry carries for its route. */
interface CatalogReasoning {
  readonly efforts: readonly CatalogEffort[]
  readonly defaultEffort?: string
}

/** One provider's advertised models, read only to prefer a display name over the model id. */
interface CatalogGroup {
  readonly id: string
  readonly models: readonly {
    readonly id: string
    readonly name: string
    readonly reasoning?: CatalogReasoning
  }[]
}

/** The observation face the Session store exposes for one projection key. */
interface ObservedFold {
  subscribe(listener: () => void): () => void
  getSnapshot(): unknown
}

/** The Host's advisory catalog: the default route plus the display names to label it with. */
interface Catalog {
  readonly default: StatedModel
  readonly groups: readonly CatalogGroup[]
}

/** Everything the seat reads: the Session's fold and the Host catalog. */
export interface ViewerModelSeatProps {
  /** Whether the composer's own owner disabled the seat; a stated model stays a label either way. */
  readonly locked: boolean
  /** The Session's durable model-selection fold, absent until the Session is bound. */
  readonly selection: ObservedFold | undefined
  /** Read the Host's advisory catalog, or undefined when it cannot be read. */
  readonly catalog: () => Promise<Catalog | undefined>
}

/** Display names and effort names keyed by provider and model id, from the catalog this Host serves. */
interface CatalogNames {
  readonly models: Map<string, string>
  readonly efforts: Map<string, Map<string, string>>
}

/**
 * Index the catalog's own names.
 * @param groups - Provider groups the Host reported.
 * @returns Display names by route, and effort names by route and effort id.
 */
function catalogNames(groups: readonly CatalogGroup[]): CatalogNames {
  const models = new Map<string, string>()
  const efforts = new Map<string, Map<string, string>>()
  for (const group of groups) {
    for (const model of group.models) {
      const route = `${group.id}/${model.id}`
      models.set(route, model.name)
      if (model.reasoning !== undefined) {
        efforts.set(route, new Map(model.reasoning.efforts.map(level => [level.id, level.name])))
      }
    }
  }
  return { models, efforts }
}

/** Reasoning metadata by route, read to resolve the effort the Session would use. */
function catalogReasoning(groups: readonly CatalogGroup[]): Map<string, CatalogReasoning> {
  const reasoning = new Map<string, CatalogReasoning>()
  for (const group of groups) {
    for (const model of group.models) {
      if (model.reasoning !== undefined) reasoning.set(`${group.id}/${model.id}`, model.reasoning)
    }
  }
  return reasoning
}

/**
 * The effort this seat states, in the reader's words.
 *
 * The Session's own selection wins, and a Session that has not chosen one shows the route's
 * provider default — the same answer the owner's own selector shows for the next request. A route
 * with no reasoning metadata, and one whose catalog entry carries no matching level, states the raw
 * effort id rather than inventing a label; a Session that states no effort at all states none.
 * @param model - The route the Session would use.
 * @param names - Effort names indexed from the catalog.
 * @param reasoning - Reasoning metadata indexed from the catalog.
 * @returns The effort's label, or undefined when nothing states an effort.
 */
function effortLabel(
  model: StatedModel,
  names: CatalogNames,
  reasoning: Map<string, CatalogReasoning>,
): string | undefined {
  const route = `${model.provider}/${model.model}`
  const effort = model.reasoningEffort ?? reasoning.get(route)?.defaultEffort
  if (effort === undefined) return undefined
  return names.efforts.get(route)?.get(effort) ?? effort
}

/**
 * Render the model and reasoning effort this Session runs on.
 * @param props - the Session's selection fold, the catalog reader, and the framework-injected
 *   translate seat.
 * @returns the seat, or nothing until the Session states a model.
 */
export function ViewerModelSeat(
  { selection, catalog, t }: ViewerModelSeatProps & PropsLocale<typeof NS>,
): ReactNode {
  const fold = useSyncExternalStore(
    listener => selection?.subscribe(listener) ?? (() => {}),
    () => selection?.getSnapshot(),
  ) as SelectionFold | undefined
  const [names, setNames] = useState<CatalogNames>()
  const [reasoning, setReasoning] = useState<Map<string, CatalogReasoning>>()
  const [fallback, setFallback] = useState<StatedModel>()
  useEffect(() => {
    let cancelled = false
    void catalog()
      .then((value) => {
        if (cancelled || value === undefined) return
        setNames(catalogNames(value.groups))
        setReasoning(catalogReasoning(value.groups))
        setFallback(value.default)
      })
      .catch(() => { /* an unreadable catalog leaves the model id stated */ })
    return () => { cancelled = true }
  }, [catalog])
  // The Session's own selection wins; the Host's default speaks for a Session that has not chosen
  // one yet, which is the same answer the owner's own selector shows.
  const model = fold?.next ?? fallback
  if (model === undefined) return null
  const route = `${model.provider}/${model.model}`
  const effort = names === undefined || reasoning === undefined
    ? model.reasoningEffort
    : effortLabel(model, names, reasoning)
  return (
    <ViewerSeat
      kind="model"
      value={[names?.models.get(route) ?? model.model, effort].filter(part => part !== undefined).join(' · ')}
      title={t('viewer.model.title')}
      note={t('viewer.model.locked')}
      readOnly
    />
  )
}

/**
 * Fill the composer's model seat with the Session's model.
 * @param ctx - the viewer page's root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.inject(['slots', 'sessions', 'remote', 'remote.session'], (scope: ClientContext) => {
    scope.slots.inject('conversation.input.model', () => scope.slots.register({
      name: 'conversation.input.model',
      priority: VIEWER_SEAT_PRIORITY,
      locale: NS,
      inject: (sessionId: SessionId) => ({
        selection: scope.sessions.binding(sessionId)?.session.projections.faceOf('modelSelection'),
        catalog: async () => {
          const response = await scope.remote.session.modelCatalog() as {
            readonly ok: boolean
            readonly value: Catalog
          }
          return response.ok ? { default: response.value.default, groups: response.value.groups } : undefined
        },
      }),
    }, ViewerModelSeat))
  })
}
