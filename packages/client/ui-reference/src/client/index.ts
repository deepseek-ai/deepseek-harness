/**
 * Unified Web `@` reference source. File and session discovery run through
 * the cancellable generated Remote namespaces in parallel with deterministic
 * ordering and labels.
 *
 * Rows carry only what distinguishes them: a file names its parent directory
 * (nothing at the workspace root), a directory listing names none because its
 * breadcrumb already does, and a session names its workspace only when that
 * workspace is not the current one. A session is dated from the Host session
 * list, so the `@` menu and the session list never disagree about its age.
 *
 * @module @deepseek-ai/dsh-client-ui-reference/client
 */
// Type-only: pulls the generated Remote API and ctx.remote merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ISessions } from '@deepseek-ai/dsh-api-session-controller/client'
import { relativeTime } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  ClientSessionContext, InputTriggerCrumb, InputTriggerServiceContract, InputTriggerSource,
} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { formatFileMention } from '@deepseek-ai/dsh-file-reference/grammar'
import type { FileReferenceCandidate } from '@deepseek-ai/dsh-file-reference/types'
import type { SessionReferenceMentionCandidate } from '@deepseek-ai/dsh-session-reference/types'
import { abbreviateHomePath, fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path'
import { en, NS, zh, type ReferenceKey } from './locales.ts'

/** Required services: the trigger registry, the Remote namespaces, and the copy. */
export const inject = [
  'inputTriggers', 'locale', 'sessions', 'remote', 'remote.fileReferences',
  'remote.sessionReferenceResolver', 'sidebarRight',
]

/**
 * Register the combined `@file` / `@session` source.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-reference: dictionaries')
  const t = ctx.locale.bind(NS)
  const sessions = ctx.get('sessions') as ISessions
  const source: InputTriggerSource = {
    trigger: '@',
    name: 'reference',
    showGroupTitle: false,
    async candidates(session: ClientSessionContext, { query, quoted, drilled, signal }) {
      const fileLookup = ctx.remote.fileReferences.list(session.sessionId, query, signal)
        .then(result => result.ok ? result.value : [])
      const sessionLookup = quoted === true
        ? Promise.resolve([] as SessionReferenceMentionCandidate[])
        : ctx.remote.sessionReferenceResolver.candidates(session.sessionId, query, signal)
          .then(result => result.ok ? result.value : [])
      const [fileItems, sessionItems] = await Promise.all([fileLookup, sessionLookup])
      if (signal.aborted) return []
      // The header already names the directory being listed; rows repeat it only
      // when there is no header to carry it.
      const withLocation = crumbsFor(query, quoted === true, drilled, t) === undefined
      const now = Date.now()
      const home = ctx.remote.$host.home
      const listed = sessions.list.getSnapshot().byId
      return [
        ...fileItems.flatMap(candidate => fileCandidate(candidate, quoted === true, withLocation, t)),
        ...sessionItems.map(candidate => sessionCandidate(
          candidate,
          listed[candidate.sessionId]?.updatedAt ?? candidate.createdAt,
          now,
          home,
          t,
        )),
      ]
    },
    header(_session: ClientSessionContext, req) {
      return crumbsFor(req.query, req.quoted === true, req.drilled, t)
    },
    onPick({ candidate, action }) {
      const value = parseCandidate(candidate.value)
      if (value?.kind === 'file') {
        // A directory row carries two verbs: the settling pick resolves the
        // folder itself as an atomic reference, while the drill action (Tab /
        // row chevron / a header crumb) keeps the literal descent text and
        // the open menu.
        if (value.fileKind === 'directory' && action === 'drill') {
          return { text: value.mention, continue: true }
        }
        return {
          insert: {
            source: 'reference',
            ref: value.mention,
            label: value.fileKind === 'directory' ? `${value.label}/` : value.label,
            appearance: value.fileKind === 'directory' ? 'folder' : 'file',
            clipboardText: value.mention,
          },
        }
      }
      if (value?.kind === 'session') {
        return {
          insert: {
            source: 'reference',
            ref: value.mention,
            label: value.label,
            appearance: 'session',
            clipboardText: value.mention,
          },
        }
      }
      return undefined
    },
    openReference(session, { ref, appearance }) {
      if (appearance !== 'file') return false
      const path = ref.startsWith('@"') ? ref.slice(2, -1) : ref.slice(1)
      const cwd = sessions.list.getSnapshot().byId[session.sessionId]?.cwd
      ctx.sidebarRight.openResource(fileAddressFor(session.sessionId, cwd, path))
      return true
    },
    codec: {
      clipboardText: ref => ref,
      serialize: ref => Promise.resolve(ref),
    },
  }
  const inputTriggers = ctx.get('inputTriggers') as InputTriggerServiceContract
  ctx.effect(() => inputTriggers.registerSource(source), 'ui-reference: @ source')
}

type Translate = (key: ReferenceKey, params?: Record<string, unknown>) => string

type ReferenceCandidateValue =
  | { kind: 'file'; fileKind: FileReferenceCandidate['kind']; label: string; mention: string }
  | { kind: 'session'; label: string; mention: string }

/**
 * The breadcrumb of a drilled directory listing, from the workspace root down
 * to the directory being listed.
 *
 * Only a drill produces one: a path the user typed carries its own context in
 * the draft, while a drill replaced the text they were reading with a deeper
 * one and owes them the way back.
 * @param query - the live query, path text following `@` or `@"`.
 * @param quoted - whether the active token is an open quoted path.
 * @param drilled - whether a drill pick, rather than typing, produced the query.
 * @param t - the reference dictionary.
 * @returns the crumbs, or undefined when this listing needs no header.
 */
function crumbsFor(
  query: string,
  quoted: boolean,
  drilled: boolean,
  t: Translate,
): readonly InputTriggerCrumb[] | undefined {
  if (!drilled) return undefined
  const slash = query.lastIndexOf('/')
  if (slash < 0) return undefined
  const segments = query.slice(0, slash).split('/').filter(segment => segment !== '')
  const crumbs: InputTriggerCrumb[] = [{
    label: t('crumb.root'),
    value: directoryValue(t('crumb.root'), quoted ? '@"' : '@'),
  }]
  for (const [index, segment] of segments.entries()) {
    const path = segments.slice(0, index + 1).join('/')
    const mention = formatFileMention({ path, kind: 'directory' }, quoted)
    // A trail whose steps cannot all be written back as mention text would
    // send the user somewhere they did not click; show no header instead.
    if (mention === undefined) return undefined
    crumbs.push({
      label: segment,
      value: directoryValue(segment, mention),
      ...(index === segments.length - 1 ? { current: true } : {}),
    })
  }
  return crumbs
}

/** Project one directory destination as the drill payload `onPick` already understands. */
function directoryValue(label: string, mention: string): string {
  const value: ReferenceCandidateValue = { kind: 'file', fileKind: 'directory', label, mention }
  return JSON.stringify(value)
}

function fileCandidate(
  candidate: FileReferenceCandidate,
  preserveQuote: boolean,
  withLocation: boolean,
  t: Translate,
) {
  const mention = formatFileMention(candidate, preserveQuote)
  if (mention === undefined) return []
  const slash = candidate.path.lastIndexOf('/')
  const name = candidate.path.slice(slash + 1)
  const parent = slash < 0 ? '' : candidate.path.slice(0, slash)
  const directory = candidate.kind === 'directory'
  const value: ReferenceCandidateValue = {
    kind: 'file',
    fileKind: candidate.kind,
    label: name,
    mention,
  }
  return [{
    name: `${name}${directory ? '/' : ''}`,
    // The location is the parent alone: repeating the name the row already
    // shows says nothing, and a workspace-root entry has no parent to name.
    ...(withLocation && parent !== '' ? { description: parent } : {}),
    icon: directory ? 'folder' as const : 'file' as const,
    section: t('section.files'),
    value: JSON.stringify(value),
    ...(directory ? { drill: true } : {}),
  }]
}

function sessionCandidate(
  candidate: SessionReferenceMentionCandidate,
  updatedAt: number,
  now: number,
  home: string | undefined,
  t: Translate,
) {
  const { unit, n } = relativeTime(updatedAt, now)
  const age = unit === 'now' ? t('time.now') : t(`time.${unit}`, { n })
  // Candidates are ranked by workspace affinity, so the location only tells
  // the user something when it is not the workspace they are already in.
  const location = candidate.sameWorkspace
    ? undefined
    : candidate.cwd === undefined ? t('candidate.noCwd') : abbreviateHomePath(candidate.cwd, home)
  const value: ReferenceCandidateValue = {
    kind: 'session',
    label: candidate.label,
    mention: candidate.mention,
  }
  return {
    name: candidate.label,
    description: location === undefined ? age : `${location} · ${age}`,
    icon: 'session' as const,
    section: t('section.sessions'),
    value: JSON.stringify(value),
  }
}

function parseCandidate(value: string | undefined): ReferenceCandidateValue | undefined {
  if (value === undefined) return undefined
  return JSON.parse(value) as ReferenceCandidateValue
}
