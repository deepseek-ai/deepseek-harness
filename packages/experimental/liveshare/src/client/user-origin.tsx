/**
 * The attribution line above a user message a shared-session reader sent.
 *
 * The durable `user/message` source records the share-viewer principal for a
 * caller other than the owner. Chat's `conversation.chat.user.before` chain seat
 * elects that source above the official user bubble; this entry supplies only
 * the label and leaves the bubble, actions, and text interaction to Chat. The
 * seat is dispatched for `user` rows alone, so steering keeps its untouched
 * official DOM. Chat's seat owner props carry the durable source unparsed; this
 * module is the only place that recognizes the share-viewer principal and owns
 * the copy.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/user-origin
 */

import type { ReactNode } from 'react'
import type { MatchedShare, PropsLocale, PropsRuntime, SlotMap } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: merges Chat's SlotMap and standard declarations into this program.
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { NS } from './locales.ts'
import { useOwnerDisplay } from './owner-display.ts'
import css from './user-origin.module.css'

/** The parts of a durable share-viewer principal this line reads. */
interface ShareViewerPrincipal {
  readonly kind?: unknown
  readonly shareId?: unknown
  readonly actor?: unknown
}

/** The durable author a shared message names: its subject and, when recorded, display name. */
export interface ShareViewerAuthor {
  readonly subjectId: string
  readonly displayName?: string
}

/**
 * The Relay-asserted author behind a durable message source.
 *
 * Session data is persisted, so every field the attribution relies on is
 * checked; an owner, legacy, or malformed source names no author.
 * @param source - Recorded `user/message` source.
 * @returns The share-viewer author, or undefined for every other author.
 */
export function shareViewerAuthor(source: unknown): ShareViewerAuthor | undefined {
  if (typeof source !== 'object' || source === null) return undefined
  const input = source as { kind?: unknown; principal?: unknown }
  if (input.kind !== 'user') return undefined
  if (typeof input.principal !== 'object' || input.principal === null) return undefined
  const principal = input.principal as ShareViewerPrincipal
  if (principal.kind !== 'share-viewer') return undefined
  if (typeof principal.shareId !== 'string' || principal.shareId.trim() === '') return undefined
  if (typeof principal.actor !== 'object' || principal.actor === null) return undefined
  const actor = principal.actor as { subjectId?: unknown; displayName?: unknown }
  const subjectId = actor.subjectId
  if (typeof subjectId !== 'string' || subjectId.trim() === '') return undefined
  const displayName = actor.displayName
  return {
    subjectId,
    ...(typeof displayName === 'string' && displayName.trim() !== '' ? { displayName } : {}),
  }
}

/**
 * The Relay-asserted subject behind a durable message source.
 * @param source - Recorded `user/message` source.
 * @returns The share-viewer subject, or undefined for every other author.
 */
export function shareViewerSubject(source: unknown): string | undefined {
  return shareViewerAuthor(source)?.subjectId
}

/** Props of the shared-session origin entry above a user message. */
export type SharedSessionOriginProps =
  PropsRuntime<'conversation.chat.user.before'>
  & PropsLocale<typeof NS>
  & MatchedShare<SlotMap['conversation.chat.user.before'], ShareViewerAuthor>

/**
 * Render the reader attribution elected for a durable share-viewer message.
 * @param props - Chat's elected chain match and this package's translator.
 * @returns The subject line.
 */
export function SharedSessionOrigin({ matched: author, t }: SharedSessionOriginProps): ReactNode {
  const owner = useOwnerDisplay()
  // A recorded display name travels with the message; older sources fall back to the current
  // reader's name for its own subject, and then to the durable id.
  const shown = author.displayName
    ?? (owner.subjectId === author.subjectId ? owner.displayName : undefined)
    ?? author.subjectId
  const label = t('inputOrigin.sharedSession', { subjectId: shown })
  return <span className={css.origin} data-liveshare-origin={author.subjectId} title={label}>{label}</span>
}
