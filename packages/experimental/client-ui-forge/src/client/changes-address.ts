/**
 * The changes view's tab type: the right-Sidebar view of one Session's local
 * changes or of one change request bound to it. Its addresses name the Session
 * and the source, `dsh-resource://forge-changes/<session>/local` or
 * `dsh-resource://forge-changes/<session>/change/<url>`, each part
 * percent-encoded; the source names the tab.
 */

import type { SidebarRightTabDefinition } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { NS } from './locales.ts'
import { numberOf } from './status.ts'

/** Kind of the changes tab. */
export const CHANGES_KIND = 'forge-changes'

/** Registry id of the changes tab type, also the key its body and title register under. */
export const CHANGES_ID = '@deepseek-ai/dsh-experimental-client-ui-forge/changes'

const PREFIX = 'dsh-resource://forge-changes/'

/** What a changes view shows. */
export type ChangesSource =
  /** The changes of the Session's checkout. */
  | { readonly kind: 'local' }
  /** The changes of one change request bound to the Session, by its binding URL. */
  | { readonly kind: 'change'; readonly url: string }

/** The Session and the source one address names. */
export interface ChangesTarget {
  /** Session whose checkout or binding the view reads. */
  readonly sessionId: SessionId
  /** What the view shows. */
  readonly source: ChangesSource
}

/** Navigation parameters of a changes tab. */
export interface ChangesParams {
  /** File to scroll to, by its path in the diff. */
  readonly path?: string
}

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightResourceParamsMap {
    /** The file a changes tab scrolls to. */
    'forge-changes': ChangesParams
  }
}

/**
 * Mint the address of a changes view.
 * @param target - Session and source.
 * @returns the `dsh-resource://forge-changes/…` address.
 */
export function changesAddress(target: ChangesTarget): string {
  const session = `${PREFIX}${encodeURIComponent(target.sessionId)}/`
  return target.source.kind === 'local' ? `${session}local` : `${session}change/${encodeURIComponent(target.source.url)}`
}

/**
 * Read the Session and source back out of a changes address.
 * @param address - a resource address.
 * @returns the target, or undefined for an address this package did not mint.
 */
export function parseChangesAddress(address: string): ChangesTarget | undefined {
  if (!address.startsWith(PREFIX)) return undefined
  const [session = '', kind, url, ...rest] = address.slice(PREFIX.length).split('/')
  if (session === '' || rest.length > 0) return undefined
  try {
    const sessionId = decodeURIComponent(session) as SessionId
    if (kind === 'local' && url === undefined) return { sessionId, source: { kind: 'local' } }
    if (kind === 'change' && url !== undefined && url !== '') return { sessionId, source: { kind: 'change', url: decodeURIComponent(url) } }
    return undefined
  } catch (error) {
    void error // A malformed percent sequence is not an address this package minted.
    return undefined
  }
}

/**
 * Name a changes view: 变更 for the local changes, #N 的变更 for a change request with a number.
 * @param source - what the view shows.
 * @param t - forge panel copy.
 * @returns the title in the current language.
 */
export function changesTitle(source: ChangesSource, t: TranslateNS<typeof NS>): string {
  const number = source.kind === 'change' ? numberOf({ ref: null, url: source.url }) : null
  return number === null ? t('diff.tab') : t('diff.tabNumbered', { number })
}

/**
 * The changes type's registry definition.
 * @param t - forge panel copy, read on every title call.
 * @returns the definition to register.
 */
export function changesDefinition(t: TranslateNS<typeof NS>): SidebarRightTabDefinition {
  return {
    id: CHANGES_ID,
    kind: CHANGES_KIND,
    keepMounted: true,
    patterns: [`${PREFIX}**`],
    canOpen: address => parseChangesAddress(address) !== undefined,
    title: (address) => {
      const target = parseChangesAddress(address)
      return target === undefined ? address : changesTitle(target.source, t)
    },
  }
}
