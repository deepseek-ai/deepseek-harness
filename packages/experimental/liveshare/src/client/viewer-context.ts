/**
 * The viewer page's own read of the share it presents.
 *
 * One answer carries both halves of the page's identity: which DSH the owner runs and who shared this
 * Session, and what the owner lets this reader do beyond reading. The page owns that read rather than
 * a component, because every surface re-reads what the share says while it renders.
 *
 * @module @deepseek-ai/dsh-experimental-liveshare/src/client/viewer-context
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { publishViewerCapabilities } from './viewer-capabilities.ts'
import { noteViewerStatusFacts } from './viewer-status.ts'
import { VIEWER_READ_TIMEOUT_MS } from '../read-budgets.ts'
import { forgetOwnerDisplay, rememberOwnerDisplay } from './owner-display.ts'

/** Owner and build facts the Relay reports for the share this page presents. */
export interface ViewerContextFacts {
  readonly owner?: string
  /** Verified subject of the share's owner; the label of last resort when no name was reported. */
  readonly ownerSubjectId?: string
  /** Display name the Relay reported for the reader viewing this page. */
  readonly viewerDisplayName?: string
  /** Subject the Relay reported for the reader viewing this page. */
  readonly viewerSubjectId?: string
  readonly dshVersion?: string
  readonly relay?: string
}

/** The facts known so far; absent fields stay unstated. */
export const viewerContextFacts = createSnapshotStore<ViewerContextFacts>({})

/**
 * Which read of this share is the current one.
 *
 * A page asks about one share, and every later ask answers for later facts: an answer that arrives
 * after a newer read started states what the share said when it was asked, which is no longer what
 * the page holds. Only the newest read may publish.
 */
let readGeneration = 0

/**
 * Forget the previous page's read and facts for the page that takes over.
 *
 * The store and the counter are module-level so every surface reads one page's answer without a
 * service; the viewer session plugin owns their lifetime and calls this when its page starts and ends,
 * so a remount or HMR replacement never inherits another page's share. Advancing the generation also
 * retires any read the previous page left in flight, so its late answer cannot publish here.
 */
export function resetViewerContext(): void {
  readGeneration += 1
  viewerContextFacts.set({})
  forgetOwnerDisplay()
}

/** One endpoint's settled answer; only its current consumer may publish status facts. */
type JsonAnswer =
  | { readonly kind: 'readable'; readonly body: Record<string, unknown> }
  | { readonly kind: 'refused'; readonly status: number }
  | { readonly kind: 'unreadable' }

/**
 * Read JSON without publishing page state.
 * @param url - Same-origin document-relative address.
 * @param signal - Page lifetime cancellation, absent for a standalone read.
 * @returns A decoded object, HTTP refusal, or unreadable outcome within the page's deadline.
 */
async function readJson(url: string, signal?: AbortSignal): Promise<JsonAnswer> {
  try {
    const deadline = AbortSignal.timeout(VIEWER_READ_TIMEOUT_MS)
    const response = await fetch(url, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal: signal === undefined ? deadline : AbortSignal.any([signal, deadline]),
    })
    if (!response.ok) return { kind: 'refused', status: response.status }
    const body: unknown = await response.json()
    return typeof body === 'object' && body !== null && !Array.isArray(body)
      ? { kind: 'readable', body: body as Record<string, unknown> }
      : { kind: 'unreadable' }
  } catch (_unreadableEndpoint) {
    // Failed JSON or transport reads establish no share or admission authority.
    return { kind: 'unreadable' }
  }
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
 * Record facts one answer states, keeping the fields it does not mention.
 * @param facts - Facts this answer carries.
 */
function noteFacts(facts: ViewerContextFacts): void {
  viewerContextFacts.set({ ...viewerContextFacts.getSnapshot(), ...facts })
}

/**
 * Read the share and optional build facts under one generation.
 *
 * Only the newest uncancelled read may publish. A usable context confirms the share's own answer and
 * clears prior notes about it; context failures close abilities and keep the page unconfirmed. Build
 * failures affect neither the share state nor the context.
 * @param basePath - Public Relay base path the served document carries.
 * @param shareId - Share this page presents.
 * @param signal - Page lifetime cancellation; absent reads expire only under their deadline.
 * @returns Completion after both reads settle; superseded or cancelled answers publish nothing.
 */
export async function readViewerContext(basePath: string, shareId: string, signal?: AbortSignal): Promise<void> {
  const generation = ++readGeneration
  const current = (): boolean => generation === readGeneration && signal?.aborted !== true
  const share = readJson(`${basePath}/__liveshare/context?shareId=${encodeURIComponent(shareId)}`, signal)
    .then((result) => {
      if (!current()) return
      const answer = result.kind === 'readable' ? result.body : undefined
      const rawCapabilities = answer?.['capabilities']
      const capabilities = typeof rawCapabilities === 'object' && rawCapabilities !== null && !Array.isArray(rawCapabilities)
        ? rawCapabilities as Record<string, unknown> : undefined
      const readable = capabilities !== undefined
      publishViewerCapabilities(readable ? answer : undefined)
      noteViewerStatusFacts({
        ...(typeof capabilities?.['online'] === 'boolean' ? { ownerOnline: capabilities['online'] } : {}),
        unconfirmed: !readable,
        ...(readable ? {
          reason: readText(capabilities, 'sessionModeReason'),
          feedFailed: false,
          unauthenticated: false,
          notFound: false,
          unreachable: false,
        } : {}),
        ...(result.kind === 'refused' && result.status === 404 ? { notFound: true } : {}),
        ...(result.kind === 'refused' && result.status === 401 ? { unauthenticated: true } : {}),
        ...(result.kind === 'unreadable' ? { unreachable: true } : {}),
      })
      const owner = readText(answer, 'ownerDisplayName') ?? readText(capabilities, 'ownerDisplayName')
      const ownerSubjectId = readText(answer, 'ownerSubjectId')
      const dshVersion = readText(answer, 'dshVersion')
      const rawViewer = typeof answer?.['viewer'] === 'object' && answer['viewer'] !== null
        && !Array.isArray(answer['viewer']) ? answer['viewer'] as Record<string, unknown> : undefined
      const viewerSubjectId = readText(rawViewer, 'subjectId')
      const viewerDisplayName = readText(rawViewer, 'displayName')
      noteFacts({
        ...(owner === undefined ? {} : { owner }),
        ...(ownerSubjectId === undefined ? {} : { ownerSubjectId }),
        ...(dshVersion === undefined ? {} : { dshVersion }),
        ...(viewerSubjectId === undefined ? {} : { viewerSubjectId }),
        ...(viewerDisplayName === undefined ? {} : { viewerDisplayName }),
      })
      if (viewerSubjectId !== undefined && viewerDisplayName !== undefined) {
        rememberOwnerDisplay({ subjectId: viewerSubjectId, displayName: viewerDisplayName })
      }
    })
  const build = readJson(`${basePath}/health`, signal).then((result) => {
    if (!current() || result.kind !== 'readable') return
    const relay = readText(result.body, 'release_id') ?? readText(result.body, 'git_sha')
    if (relay !== undefined) noteFacts({ relay })
  })
  await Promise.all([share, build])
}
