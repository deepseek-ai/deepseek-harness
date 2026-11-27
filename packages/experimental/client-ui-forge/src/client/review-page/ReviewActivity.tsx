/**
 * The summary tab's activity of one change request: its comments, submitted reviews, commits, and changes of state,
 * oldest first, and the field that adds a comment.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconBranchOutlineRegular, IconCheckCircleOutlineRegular, IconChevronDownOutlineRegular, IconClockOutlineRegular,
  IconCloseCircleFillRegular, IconEditOutlineRegular, IconEyeOutlineRegular, IconUserOutlineRegular, MarkdownText, ShortcutKeys,
  type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots/client'
import type { ChangeRequestActivity, ForgeCommentAuthor, ReviewVerdict } from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import { openOnLabel } from '../forge-copy.ts'
import { formatAgo } from '../format.ts'
import { ChangeRequestGlyph } from '../glyphs.tsx'
import type { NS } from '../locales.ts'
import { Avatar } from '../ReviewThreads.tsx'
import { activityEntries, longBody, type ActivityCommit, type ActivityEvent } from './review-activity.ts'
import { descriptionMarkdown } from './review-lists.ts'
import { ActivitySkeleton } from './ReviewSkeleton.tsx'
import css from './ReviewPage.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Stands for the actor's name in a translated sentence, so each locale keeps its word order around the name. */
const ACTOR = '\u0000'

/** Characters of a commit's object name a row shows. */
const SHORT_SHA = 7

/** Props of the activity. */
export interface ReviewActivityProps {
  /** URL of the change request. */
  readonly url: string
  /** A value that differs once the change request changed, after which the activity is read again. */
  readonly revision: string
  /** Product name of the change request's code host, or null once its provider left. */
  readonly forge: string | null
  /** Read the activity; null for a provider that reads none. */
  readonly read: (url: string, signal: AbortSignal) => Promise<RemoteResult<ChangeRequestActivity | null>>
  /** Add a comment to the conversation. */
  readonly comment: (url: string, body: string) => Promise<RemoteResult<void>>
  /** Show the changes tab. */
  readonly onOpenChanges: () => void
  /** Show the changes tab with one commit chosen, named as the activity names it. */
  readonly onOpenCommit: (sha: string) => void
  /** Open a web page in the browser. */
  readonly openLink: (url: string) => void
  /** Current epoch milliseconds for relative times. */
  readonly now: number
  /** Localized labels of rendered Markdown. */
  readonly markdown: MarkdownLabels
  /** Forge panel copy. */
  readonly t: Translate
}

/** The latest read of one change request's activity. */
interface ActivityRead {
  readonly url: string
  /** The activity, null for a provider that reads none, or undefined while no read of this URL succeeded. */
  readonly activity: ChangeRequestActivity | null | undefined
  readonly failure: string | null
}

/**
 * The activity of one change request, read again when the change request changes;
 * an earlier read stays while a later one fails.
 */
function useActivity(url: string, revision: string, read: ReviewActivityProps['read']): {
  readonly activity: ChangeRequestActivity | null | undefined
  readonly failure: string | null
  readonly reload: () => void
} {
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<ActivityRead | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void read(url, controller.signal).then((result) => {
      if (controller.signal.aborted) return
      setState(previous => result.ok
        ? { url, activity: result.value, failure: null }
        : { url, activity: previous?.url === url ? previous.activity : undefined, failure: result.error.message })
    })
    return () => { controller.abort() }
  }, [url, revision, attempt, read])
  const current = state?.url === url ? state : null
  return { activity: current?.activity, failure: current?.failure ?? null, reload: () => { setAttempt(value => value + 1) } }
}

/** The glyph of a commit. */
function CommitGlyph(): ReactNode {
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round"
      aria-hidden="true">
      <circle cx={8} cy={8} r={2.75} />
      <path d="M1.5 8h3.75M10.75 8h3.75" />
    </svg>
  )
}

/**
 * One line of the activity: a glyph, what happened, when, and what stands at its end. With `act` it is a button of that
 * accessible name.
 */
function Line({ glyph, tone, text, at, end, nested = false, expanded, act, now, t }: {
  readonly glyph: ReactNode
  readonly tone?: 'success' | 'error' | undefined
  readonly text: ReactNode
  readonly at: string
  readonly end?: ReactNode
  readonly nested?: boolean
  readonly expanded?: boolean | undefined
  readonly act?: { readonly label: string; readonly run: () => void } | undefined
  readonly now: number
  readonly t: Translate
}): ReactNode {
  const content = (
    <>
      <span className={css.activityGlyph} data-tone={tone}>{glyph}</span>
      <span className={css.activityText}>{text}</span>
      <span className={css.activityTime}>{formatAgo(at, now, t)}</span>
      {end !== undefined && <span className={css.activityEnd}>{end}</span>}
    </>
  )
  const className = clsx(css.activityLine, nested && css.activityNested)
  return act === undefined
    ? <div className={className} data-forge-review-line="">{content}</div>
    : (
      <button type="button" className={className} data-forge-review-line="" aria-label={act.label} aria-expanded={expanded}
        onClick={act.run}>
        {content}
      </button>
    )
}

/** A translated sentence with the actor's name set apart from the rest. */
function sentence(text: string, actor: ForgeCommentAuthor | null, t: Translate): ReactNode {
  const [before, ...after] = text.split(ACTOR)
  const name = actor?.login ?? t('thread.deletedAuthor')
  return <>{before}<b className={css.activityActor}>{name}</b><span className={css.activityRest}>{after.join('')}</span></>
}

/** One commit: its title, its time, and the start of its object name. The line opens the changes tab on that commit. */
function CommitLine({ commit, nested, onOpen, now, t }: {
  readonly commit: ActivityCommit
  readonly nested: boolean
  readonly onOpen: ReviewActivityProps['onOpenCommit']
  readonly now: number
  readonly t: Translate
}): ReactNode {
  return (
    <Line glyph={<CommitGlyph />} text={nested ? commit.title : <b className={css.activityActor}>{commit.title}</b>} at={commit.at}
      nested={nested} end={<span className={css.activitySha}>{commit.sha.slice(0, SHORT_SHA)}</span>} now={now} t={t}
      act={{ label: `${commit.title}, ${t('reviewPage.activity.viewInChanges')}`, run: () => { onOpen(commit.sha) } }} />
  )
}

/** A run of commits: one commit as its own line, several as a line that unfolds them. */
function Commits({ commits, onOpen, now, t }: {
  readonly commits: readonly [ActivityCommit, ...ActivityCommit[]]
  readonly onOpen: ReviewActivityProps['onOpenCommit']
  readonly now: number
  readonly t: Translate
}): ReactNode {
  const [open, setOpen] = useState(false)
  const [first, ...later] = commits
  const last = later.at(-1)
  if (last === undefined) return <CommitLine commit={first} nested={false} onOpen={onOpen} now={now} t={t} />
  const count = t('reviewPage.activity.commits', { count: commits.length })
  return (
    <>
      <Line glyph={<CommitGlyph />} text={<b className={css.activityActor}>{count}</b>}
        at={last.at} expanded={open} act={{ label: count, run: () => { setOpen(!open) } }} now={now} t={t}
        end={<IconChevronDownOutlineRegular size={12} className={clsx(css.chevron, !open && css.chevronClosed)} />} />
      {open && commits.map(commit => <CommitLine key={commit.sha} commit={commit} nested onOpen={onOpen} now={now} t={t} />)}
    </>
  )
}

/** A comment's author, time, and text; a long text starts cut short. */
function CommentCard({ actor, at, body, now, markdown, t }: {
  readonly actor: ForgeCommentAuthor | null
  readonly at: string
  readonly body: string
  readonly now: number
  readonly markdown: MarkdownLabels
  readonly t: Translate
}): ReactNode {
  const long = longBody(body)
  const [open, setOpen] = useState(false)
  const text = useMemo(() => descriptionMarkdown(body, {}), [body])
  return (
    <div className={css.activityComment} data-forge-review-comment="">
      <div className={css.activityCommentHead}>
        <Avatar author={actor} size={20} />
        <b className={css.activityActor}>{actor?.login ?? t('thread.deletedAuthor')}</b>
        {actor?.bot === true && <span className={css.activityTag}>{t('thread.bot')}</span>}
        <span className={css.activityTime}>{formatAgo(at, now, t)}</span>
      </div>
      <div className={clsx(css.activityBody, long && !open && css.activityClamp)}>
        <MarkdownText text={text} labels={markdown} variant="compact" omitHtml />
      </div>
      {long && (
        <button type="button" className={css.activityMore} aria-expanded={open} onClick={() => { setOpen(!open) }}>
          {t(open ? 'thread.collapse' : 'thread.expand')}
        </button>
      )}
    </div>
  )
}

/** The glyph, tone, and sentence of a submitted review's decision. */
function verdictLine(verdict: ReviewVerdict, t: Translate): {
  readonly glyph: ReactNode
  readonly tone: 'success' | 'error' | undefined
  readonly text: string
} {
  const actor = { actor: ACTOR }
  switch (verdict) {
    case 'approved':
      return { glyph: <IconCheckCircleOutlineRegular size={16} />, tone: 'success', text: t('reviewPage.activity.approved', actor) }
    case 'changes-requested':
      return { glyph: <IconEditOutlineRegular size={16} />, tone: 'error', text: t('reviewPage.activity.changesRequested', actor) }
    case 'commented':
      return { glyph: <IconEyeOutlineRegular size={16} />, tone: undefined, text: t('reviewPage.activity.commented', actor) }
    case 'dismissed':
      return { glyph: <IconCloseCircleFillRegular size={16} />, tone: undefined, text: t('reviewPage.activity.dismissed', actor) }
    /* v8 ignore next -- closed ReviewVerdict union exhaustiveness guard */
    default: return assertNever(verdict, 'ReviewVerdict')
  }
}

/** One activity item other than a commit. */
function Event({ item, onOpenChanges, now, markdown, t }: {
  readonly item: ActivityEvent
  readonly onOpenChanges: () => void
  readonly now: number
  readonly markdown: MarkdownLabels
  readonly t: Translate
}): ReactNode {
  const line = (glyph: ReactNode, text: string): ReactNode => (
    <Line glyph={glyph} text={sentence(text, item.actor, t)} at={item.at} now={now} t={t} />
  )
  switch (item.kind) {
    case 'comment':
      return <CommentCard actor={item.actor} at={item.at} body={item.body} now={now} markdown={markdown} t={t} />
    case 'review': {
      const { glyph, tone, text } = verdictLine(item.verdict, t)
      // A review that left comments on lines or files opens the changes tab, where they show.
      const inline = item.comments === 0 ? undefined : {
        text: `${text} · ${t('reviewPage.activity.inline', { count: item.comments })}`, open: t('reviewPage.activity.viewInChanges'),
      }
      const name = item.actor?.login ?? t('thread.deletedAuthor')
      return (
        <>
          <Line glyph={glyph} tone={tone} text={sentence(inline?.text ?? text, item.actor, t)} at={item.at} now={now} t={t}
            end={inline?.open}
            act={inline === undefined ? undefined : { label: `${inline.text.replace(ACTOR, name)}, ${inline.open}`, run: onOpenChanges }} />
          {item.body.trim() !== '' && <CommentCard actor={item.actor} at={item.at} body={item.body} now={now} markdown={markdown} t={t} />}
        </>
      )
    }
    case 'merged': return line(<ChangeRequestGlyph tone="merged" size={16} />, t('reviewPage.activity.merged', { actor: ACTOR }))
    case 'closed': return line(<ChangeRequestGlyph tone="closed" size={16} />, t('reviewPage.activity.closed', { actor: ACTOR }))
    case 'reopened': return line(<ChangeRequestGlyph tone="open" size={16} />, t('reviewPage.activity.reopened', { actor: ACTOR }))
    case 'ready-for-review': return line(<IconEyeOutlineRegular size={16} />, t('reviewPage.activity.readyForReview', { actor: ACTOR }))
    case 'converted-to-draft':
      return line(<ChangeRequestGlyph tone="draft" tinted={false} size={16} />, t('reviewPage.activity.convertedToDraft', { actor: ACTOR }))
    case 'force-pushed': return line(<IconBranchOutlineRegular size={16} />, t('reviewPage.activity.forcePushed', { actor: ACTOR }))
    case 'auto-merge-enabled':
      return line(<IconCheckCircleOutlineRegular size={16} />, t('reviewPage.activity.autoMergeEnabled', { actor: ACTOR }))
    case 'auto-merge-disabled':
      return line(<IconClockOutlineRegular size={16} />, t('reviewPage.activity.autoMergeDisabled', { actor: ACTOR }))
    case 'review-requested':
      return line(<IconUserOutlineRegular size={16} />, item.reviewer === null
        ? t('reviewPage.activity.reviewRequestedUnnamed', { actor: ACTOR })
        : t('reviewPage.activity.reviewRequested', { actor: ACTOR, reviewer: item.reviewer }))
    case 'renamed':
      return line(<IconEditOutlineRegular size={16} />, t('reviewPage.activity.renamed', { actor: ACTOR, from: item.from, to: item.to }))
    case 'other': return line(<IconClockOutlineRegular size={16} />, `${ACTOR} ${item.text}`)
    /* v8 ignore next -- closed ChangeRequestActivityItem kind union exhaustiveness guard */
    default: return assertNever(item, 'ChangeRequestActivityItem.kind')
  }
}

/**
 * The keys that send a comment, as the shortcut reference labels them: Command with Enter on Apple platforms, Control
 * with Enter elsewhere. The desktop shell names the platform on the document; a browser names it itself.
 */
function sendKeys(): readonly string[] {
  const platform = document.documentElement.dataset['platform'] ?? navigator.platform
  return /darwin|mac|iphone|ipad/iu.test(platform) ? ['⌘', 'Enter'] : ['Ctrl', '+', 'Enter']
}

/**
 * The field that adds a comment: three lines that grow with the text, over a row that says where the comment goes and
 * holds the button that sends it. It keeps its text until the host saved the comment, and says why one was not saved.
 */
function Composer({ url, forge, comment, onPosted, t }: {
  readonly url: string
  readonly forge: string | null
  readonly comment: ReviewActivityProps['comment']
  readonly onPosted: () => void
  readonly t: Translate
}): ReactNode {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const field = useRef<HTMLTextAreaElement>(null)
  const keys = useMemo(sendKeys, [])
  // The field is as tall as its text, between the heights its style allows.
  useEffect(() => {
    const element = field.current
    element?.style.setProperty('height', 'auto')
    element?.style.setProperty('height', `${element.scrollHeight}px`)
  }, [text])
  // One comment is sent at a time; the field stays focused and read-only meanwhile.
  const post = async (): Promise<void> => {
    if (busy || text.trim() === '') return
    setBusy(true)
    setError(null)
    const result = await comment(url, text)
    setBusy(false)
    if (result.ok) {
      setText('')
      onPosted()
    } else if (result.error.code === 'forgePanel/action-unknown' && forge !== null) {
      setError(t('review.unknown', { forge }))
    } else {
      setError(t('reviewPage.activity.commentFailed', { message: result.error.message }))
    }
  }
  return (
    <div className={css.activityCompose}>
      <div className={css.activityComposer} aria-busy={busy}>
        <textarea ref={field} rows={3} value={text} readOnly={busy} aria-label={t('reviewPage.activity.commentPlaceholder')}
          placeholder={t('reviewPage.activity.commentPlaceholder')} onChange={(event) => { setText(event.target.value) }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void post()
            }
          }} />
        <div className={css.activityComposerFoot}>
          <span className={css.activityComposerHint}>
            {forge === null ? t('reviewPage.activity.commentHintPlain') : t('reviewPage.activity.commentHint', { forge })}
          </span>
          <span className={css.activityComposerKeys} aria-hidden="true"><ShortcutKeys keys={keys} /></span>
          <Button size="sm" variant="primary" className={css.activitySend} disabled={busy || text.trim() === ''}
            onClick={() => { void post() }}>
            {t(busy ? 'reviewPage.activity.commenting' : 'reviewPage.activity.comment')}
          </Button>
        </div>
      </div>
      {error !== null && <p className={css.activityError} role="alert">{error}</p>}
    </div>
  )
}

/**
 * Render the activity of one change request, and nothing for a provider that reads none.
 * @param props - the change request, its reads and writes, and copy.
 * @returns the activity section.
 */
export function ReviewActivity({
  url, revision, forge, read, comment, onOpenChanges, onOpenCommit, openLink, now, markdown, t,
}: ReviewActivityProps): ReactNode {
  const { activity, failure, reload } = useActivity(url, revision, read)
  const entries = useMemo(() => activityEntries(activity?.items ?? []), [activity])
  if (activity === null) return null
  return (
    <section className={css.activity} aria-label={t('reviewPage.activity')} data-forge-review-activity="">
      <h3 className={css.caption}>{t('reviewPage.activity')}</h3>
      {failure !== null && (
        <div className={css.notice} role="status">
          <span>{t('reviewPage.activity.failed', { message: failure })}</span>
          <Button size="sm" variant="outline" onClick={reload}>{t('retry')}</Button>
        </div>
      )}
      {activity === undefined
        ? failure === null && <ActivitySkeleton />
        : (
          <>
            {activity.truncated && (
              <p className={css.activityOlder}>
                {t('reviewPage.activity.older')}
                <button type="button" className={css.activityMore} onClick={() => { openLink(url) }}>{openOnLabel(t, forge)}</button>
              </p>
            )}
            {entries.length === 0 && <p className={css.muted}>{t('reviewPage.activity.empty')}</p>}
            <div className={css.activityLines}>
              {entries.map(entry => entry.kind === 'commits'
                ? <Commits key={entry.key} commits={entry.commits} onOpen={onOpenCommit} now={now} t={t} />
                : <Event key={entry.key} item={entry.item} onOpenChanges={onOpenChanges} now={now} markdown={markdown} t={t} />)}
            </div>
            {activity.viewerCanComment && <Composer url={url} forge={forge} comment={comment} onPosted={reload} t={t} />}
          </>
        )}
    </section>
  )
}
