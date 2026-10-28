/**
 * The viewer page's brand row: the sidebar's own mark and name seats carry the share.
 *
 * The page renders the normal client UI, so its identity belongs where every DSH page keeps one —
 * the expanded sidebar's brand row — instead of a floating banner. The mark stays the shipped
 * Harness logo; the name seat becomes the way home and states, compactly, who shared this Session
 * and which DSH built it. The Relay's own release stays a detail on that link rather than a second
 * identifier in the page's chrome.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-brand
 */

import { useSyncExternalStore, type ReactNode } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { NS } from './locales.ts'
import { identitySubjectLabel } from '../owner-identity.ts'
import { viewerContextFacts } from './viewer-context.ts'
import css from './viewer-brand.module.css'

export const name = 'liveshare-viewer-brand'

/**
 * Registration rank for the viewer's brand seats.
 *
 * `sidebar.brand.mark` and `sidebar.brand.name` are single slots, and a served viewer page mounts the
 * owner's own plugins, so the shipped brand (including `ui-brand-official`, which registers both at
 * the default rank on official builds) is already registered at rank 0. A second registration at that
 * rank fails, so the viewer entry registers below it and shadows the shipped one.
 */
export const VIEWER_BRAND_PRIORITY = -10

/** The slot registry is the only service this plugin reads. */
export const inject: readonly string[] = ['slots']

/** Window global the shell installs for the share this page presents. */
interface ViewerTargetWindow {
  __DSH_LIVESHARE_VIEWER__?: {
    readonly shareId: string
    readonly sessionId: string
    readonly basePath: string
  }
}

/** The page's own read publishes the facts; the seat states whichever have arrived. */
function useViewerContextFacts(): ReturnType<typeof viewerContextFacts.getSnapshot> {
  return useSyncExternalStore(
    listener => viewerContextFacts.subscribe(listener),
    () => viewerContextFacts.getSnapshot(),
  )
}

/**
 * Render the mark slot: the shipped Harness logo at the shell's requested size.
 * @param props - Host-supplied mark presentation.
 * @returns the Harness mark.
 */
export function ViewerBrandMark({ size }: SidebarBrandMarkOwnerProps): ReactNode {
  return <FishLogo size={size} />
}

/**
 * Render the name slot: LiveShare, its owner, and the owner's DSH version, linked to the page's
 * share directory. The Relay's release rides the same link's tooltip so a long identifier stays
 * readable on demand instead of widening the row.
 * @param props - The framework-injected translate seat for this package's copy.
 * @returns the viewer's brand content.
 */
export function ViewerBrandName({ t }: PropsLocale<typeof NS>): ReactNode {
  const target = (globalThis as ViewerTargetWindow).__DSH_LIVESHARE_VIEWER__
  const basePath = target?.basePath ?? ''
  const facts = useViewerContextFacts()
  // The share's own identity data names its owner: a verified subject without a display name is
  // labelled from the subject itself, and an unstated identity stays unstated.
  const owner = facts.owner
    ?? (facts.ownerSubjectId === undefined
      ? t('viewer.picker.ownerUnknown')
      : t('viewer.picker.subjectLabel', { label: identitySubjectLabel(facts.ownerSubjectId) }))
  const ownerLine = t('viewer.sharedByShort', { owner })
  const version = facts.dshVersion === undefined
    ? undefined
    // Inline, the chip states the release the owner runs. Build metadata and the Relay's own
    // release stay on the link's tooltip, so a long identifier never widens the row.
    : `${t('viewer.picker.version')} ${facts.dshVersion.replace(/\+.*$/u, '')}`
  const relay = facts.relay === undefined ? undefined : t('viewer.relayVersion', { release: facts.relay })
  return (
    <a
      className={css.brand}
      href={`${basePath}/`}
      aria-label={t('viewer.home')}
      title={[
        ownerLine,
        facts.dshVersion === undefined ? undefined : `${t('viewer.picker.version')} ${facts.dshVersion}`,
        relay,
      ].filter(value => value !== undefined).join(' · ')}
    >
      <span className={css.top}>
        <span className={css.wordmark}>{t('viewer.brand')}</span>
        {version === undefined ? null : <span className={css.version}>{version}</span>}
      </span>
      <span className={css.owner}>{ownerLine}</span>
    </a>
  )
}

/**
 * Fill the sidebar's brand seats with the viewer's own identity.
 * @param ctx - browser context of the viewer's module table.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark', priority: VIEWER_BRAND_PRIORITY }, ViewerBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', priority: VIEWER_BRAND_PRIORITY, locale: NS }, ViewerBrandName)
    }))
}
