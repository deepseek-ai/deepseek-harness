/**
 * The one mode one share's owner explicitly grants this viewer page.
 *
 * Admission (anyone in the organization with the link, or an approved request) never implies a mode:
 * the page starts at `view`, an older share that never granted anything stays there, and an answer
 * the page cannot read — or one naming a mode this build does not know — leaves it there rather than
 * assuming more.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-capabilities
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/**
 * What one owner lets a viewer do with a share, as one of two tiers.
 *
 * The same two tiers the owner's own permission presets name. `view` reads the shared Session and
 * drives its loop inside the granted workspace without writing it; `write` also modifies the files
 * inside that workspace. Neither reconfigures the Session, and forking is a separate switch the
 * share reports on its own.
 */
export type ViewerSessionMode = 'view' | 'write'

/** Owner-granted abilities this page holds for the share it presents. */
export interface ViewerCapabilities {
  /** Mode the share is in; `view` until an answer says otherwise. */
  readonly mode: ViewerSessionMode
  /** Stable code behind that answer, when the host named one. */
  readonly reason?: string
  /**
   * Whether the page's last read of the share answered nothing it could read.
   *
   * The mode still holds the narrowest value, because nothing was granted, but the page has not
   * confirmed what the share is: a surface that states a reason says so instead of stating the
   * read-only fact as though the share had answered.
   */
  readonly unconfirmed?: true
}

/** The one capability set the page holds; the mode starts at the narrowest one. */
export const viewerCapabilities = createSnapshotStore<ViewerCapabilities>({ mode: 'view' })

/**
 * Return the capability store to the state a page that read nothing holds.
 *
 * The viewer session plugin owns the store's lifetime and calls this when its page starts and ends, so
 * a remount or HMR replacement cannot inherit the tier another page's share granted.
 */
export function resetViewerCapabilities(): void {
  viewerCapabilities.set({ mode: 'view' })
}

/**
 * Refusal codes that settle the page itself: the share is gone, expired, or this reader lost it.
 *
 * Nothing this page does can change that verdict, so every Session it holds states the reason instead
 * of the read-only fact it states while the share is merely read-only.
 */
export const PAGE_WIDE_REFUSALS: ReadonlySet<string> = new Set([
  'share-stopped',
  'share-expired',
  'viewer-not-authorized',
])

/** Every tier an owner may set, narrowest first. An answer naming anything else stays `view`. */
export const SESSION_MODES: readonly ViewerSessionMode[] = ['view', 'write']

/** Tiers this build knows. */
const KNOWN_MODES: ReadonlySet<string> = new Set(SESSION_MODES)

/**
 * Read one tier a Host reported.
 *
 * The withdrawn `fork-readonly` tier reads as `view`: it granted forking, which the share's own fork
 * switch carries now, so a link created under it keeps its width without naming a tier this build no
 * longer offers.
 * @param value - Value a Host reported, of any type.
 * @returns The tier, or undefined when this build does not know it.
 */
export function readSessionMode(value: unknown): ViewerSessionMode | undefined {
  if (value === 'fork-readonly') return 'view'
  return typeof value === 'string' && KNOWN_MODES.has(value)
    ? value as ViewerSessionMode
    : undefined
}

/**
 * Read one non-empty string field from a decoded JSON object.
 * @param source - Decoded object, absent when its endpoint could not be read.
 * @param key - Field to read.
 * @returns The value, or undefined when the field is absent, empty, or not a string.
 */
function readText(source: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = source?.[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

/**
 * Read the mode out of one decoded capabilities object.
 *
 * An absent mode is an older Host whose only statement about reach is the branching grant it still
 * reports; that grant is forking, which is no tier of its own, so the page holds `view`. A mode this
 * build does not know is the other direction: the answer names a mode this build is too old to
 * understand, so it holds `view` rather than guessing from a field that Host may no longer honour.
 * Neither direction reaches `write`.
 * @param capabilities - The answer's `capabilities` object, when it carried one.
 * @returns The tier and the code behind it, or the closed default.
 */
function readMode(capabilities: Record<string, unknown> | undefined): ViewerCapabilities {
  const fork = capabilities?.['fork']
  const forkRecord = typeof fork === 'object' && fork !== null ? fork as Record<string, unknown> : undefined
  // The code travels with whichever field carried it: this build's own, or the older branching grant
  // the same answer still reports while a Host migrates.
  const reason = readText(capabilities, 'sessionModeReason')
    ?? readText(forkRecord, 'reason')
  const reported = capabilities?.['sessionMode']
  const named = readSessionMode(reported)
  if (named !== undefined) {
    return { mode: named, ...(reason === undefined ? {} : { reason }) }
  }
  // A field this build cannot read is a Host newer than this build: the page holds the narrowest mode
  // rather than guessing from a legacy grant that Host may no longer honour.
  if (reported !== undefined) return { mode: 'view', ...(reason === undefined ? {} : { reason }) }
  // No mode field at all is an older Host, and a branching grant is a fork switch rather than a tier;
  // nothing that Host said about reach becomes write.
  return { mode: 'view', ...(reason === undefined ? {} : { reason }) }
}

/**
 * Read what one `/__liveshare/context` answer grants this page.
 * @param context - Decoded context body, or undefined when unreadable.
 * @returns The mode this page holds after that answer.
 */
export function readViewerCapabilities(context: unknown): ViewerCapabilities {
  // An unreadable answer — a refusal, a body this build cannot parse, or no answer in time — leaves
  // the page unable to confirm anything about the share, which it says rather than assuming the
  // read-only fact an answer that arrived would have stated.
  if (typeof context !== 'object' || context === null) return { mode: 'view', unconfirmed: true }
  const capabilities = (context as Record<string, unknown>)['capabilities']
  if (typeof capabilities !== 'object' || capabilities === null) return { mode: 'view', unconfirmed: true }
  return readMode(capabilities as Record<string, unknown>)
}

/**
 * Publish what one context answer grants this page.
 * @param context - Decoded context body, or undefined when unreadable.
 */
export function publishViewerCapabilities(context: unknown): void {
  viewerCapabilities.set(readViewerCapabilities(context))
}
