/**
 * Read-only review threads of a change request inside the changes view: a thread card at its lines or at the top of
 * its file, a resolved thread folded into one row, and the outdated threads of a file in a section after its lines.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconRightUpOutlineRegular, MarkdownText, Tag, type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeReviewComment, ForgeReviewThread, ForgeThreadId } from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { formatAgo } from './format.ts'
import { anchorRange, hunkExcerpt, type ThreadPlace } from './review-threads.ts'
import type { NS } from './locales.ts'
import css from './ReviewThreads.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Reads, actions, and identities every thread card of one changes view shares. */
export interface ThreadActions {
  /** Login of the change request's author, or null when the host hides it. */
  readonly author: string | null
  /** Quote the whole thread in the main input without sending it; false when the input refused it. */
  readonly addToInput: (thread: ForgeReviewThread, range: string | null) => boolean
  /** Open a URL outside the app. */
  readonly openLink: (url: string) => void
  /** Read a file of the change request's repository at a commit. */
  readonly readText: (commit: string, path: string) => Promise<RemoteResult<string>>
  /** Report that the input refused a thread. */
  readonly inputFailed: () => void
  /** The latest jump to a thread, which unfolds that thread and its section until the reader folds them again; null before any. */
  readonly focused: ThreadFocus | null
}

/** One jump to a thread; each jump has its own revision, so a jump to the same thread unfolds it again. */
export interface ThreadFocus {
  readonly id: ForgeThreadId
  readonly revision: number
}

/** A host thread shown on lines of one side. */
export interface LineThread {
  readonly thread: ForgeReviewThread
  readonly place: Extract<ThreadPlace, { readonly kind: 'line' }>
}

/** Host threads of one file and the actions their cards share. */
export interface FileThreads {
  /** Threads on lines, which follow the row of their last line. */
  readonly lines: readonly LineThread[]
  /** Threads on the whole file, shown above its lines. */
  readonly file: readonly ForgeReviewThread[]
  /** Threads no longer on the head's lines, shown after them. */
  readonly outdated: readonly ForgeReviewThread[]
  /** Unresolved threads of the file in every place, including threads the chosen commits do not show. */
  readonly unresolved: number
  /** Reads, actions, and identities shared by the cards. */
  readonly actions: ThreadActions
}

/** The commit a thread was written on, abbreviated, or null for a file thread. */
function writtenOn(thread: ForgeReviewThread): string | null {
  return thread.original === null ? null : thread.original.commit.slice(0, 7)
}

/**
 * Build the Markdown chrome copy of comment bodies.
 * @param t - forge panel copy.
 * @returns labels for code fences and footnotes.
 */
export function useMarkdownLabels(t: Translate): MarkdownLabels {
  return useMemo(() => ({
    code: { copyLabel: t('thread.copy'), copiedLabel: t('thread.copied'),
      toolbarLabels: { codeLabel: t('thread.codeBlock'), wrapLabel: t('thread.wrap'), unwrapLabel: t('thread.unwrap') } },
    footnotes: t('thread.footnotes'),
  }), [t])
}

/**
 * Render an author's avatar, or the first letter of the login when the image is missing or fails.
 * @param props - the comment's author and the avatar size.
 * @returns the round avatar.
 */
export function Avatar({ author, size = 20 }: { readonly author: ForgeReviewComment['author']; readonly size?: number }): ReactNode {
  const [failed, setFailed] = useState(false)
  const login = author?.login ?? '?'
  return <span className={css.avatar} style={{ width: size, height: size, fontSize: Math.round(size * 0.45) }} aria-hidden="true">
    {author?.avatarUrl != null && !failed
      ? <img src={author.avatarUrl} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => { setFailed(true) }} />
      : login.slice(0, 1).toUpperCase()}
  </span>
}

function Comment({ comment, actions, labels, now, t }: {
  readonly comment: ForgeReviewComment
  readonly actions: ThreadActions
  readonly labels: MarkdownLabels
  readonly now: number
  readonly t: Translate
}): ReactNode {
  const login = comment.author?.login ?? null
  return <div className={css.comment} data-forge-thread-comment={comment.id}>
    <Avatar author={comment.author} />
    <div className={css.commentMain}>
      <div className={css.commentHeader}>
        <span className={css.login}>{login ?? t('thread.deletedAuthor')}</span>
        <span className={css.time} title={comment.createdAt}>{formatAgo(comment.createdAt, now, t) ?? comment.createdAt}</span>
        {login !== null && login === actions.author && <Tag tone="outline">{t('thread.author')}</Tag>}
        {comment.author?.bot === true && <Tag tone="outline">{t('thread.bot')}</Tag>}
        {comment.pending && <Tag tone="warning">{t('review.pending')}</Tag>}
      </div>
      {/* Raw HTML renders nothing, as GitHub hides comments and unknown tags, and never enters the DOM. */}
      <div className={css.body}><MarkdownText text={comment.body} labels={labels} variant="body" omitHtml /></div>
    </div>
  </div>
}

/**
 * Render one thread: its place, every comment, and the read-only actions. A resolved thread folds into one row
 * until the reader unfolds it or jumps to it.
 * @param props - the thread, where it shows, the shared actions, the layout, and copy.
 * @returns the thread card or its folded row.
 */
export function ThreadCard({ thread, place, actions, split = false, t }: PropsLocale<typeof NS> & {
  readonly thread: ForgeReviewThread
  readonly place: ThreadPlace
  readonly actions: ThreadActions
  /** Whether the card sits under the side of a side-by-side row that its lines number. */
  readonly split?: boolean
}): ReactNode {
  const [open, setOpen] = useState(false)
  // The jump the reader folded the thread after, which no longer unfolds it.
  const [foldedAt, setFoldedAt] = useState<number | null>(null)
  const labels = useMarkdownLabels(t)
  const now = Date.now()
  const focused = actions.focused?.id === thread.id && actions.focused.revision !== foldedAt
  const unfolded = open || !thread.resolved || focused
  const side = place.kind === 'line' ? place.side : thread.side
  const original = place.kind === 'outdated' && thread.original !== null ? thread.original : null
  // The composer names an outdated thread by the lines it was written on, as its label does.
  const range = place.kind === 'line' ? anchorRange(place.side, place) : original !== null ? anchorRange(thread.side, original) : null
  const commit = writtenOn(thread)
  const first = thread.comments[0]
  const url = first?.url ?? null
  if (!unfolded) {
    return <div className={css.folded} data-forge-thread={thread.id} data-side={side} data-split={split ? '' : undefined}>
      <IconCheckOutlineRegular size={14} />
      <span className={css.foldedText}>{t('thread.resolvedRow', { author: first?.author?.login ?? t('thread.deletedAuthor') })}</span>
      <button type="button" className={css.link} aria-expanded={false} onClick={() => { setOpen(true) }}>{t('thread.expand')}</button>
    </div>
  }
  const label = original !== null ? t('thread.originally', { range: anchorRange(thread.side, original) }) : range ?? t('thread.fileLevel')
  return <section className={css.card} data-forge-thread={thread.id} data-side={side} data-split={split ? '' : undefined}
    data-resolved={thread.resolved ? '' : undefined} aria-label={label} tabIndex={-1}>
    <div className={css.header}>
      <span className={css.place}>
        {label}
        {commit !== null && <> · {t('thread.onCommit', { commit })}</>}
      </span>
      {place.kind === 'outdated' && <Tag tone="warning">{t('thread.outdatedTag')}</Tag>}
      {thread.resolved && <Tag tone="success">{t('thread.filter.resolved')}</Tag>}
      <span className={css.spacer} />
      {thread.resolved && <button type="button" className={css.link} aria-expanded onClick={() => {
        setOpen(false)
        setFoldedAt(actions.focused?.revision ?? null)
      }}>{t('thread.collapse')}</button>}
      {original !== null && thread.side === 'R' && <OriginalFile thread={thread} commit={original.commit} actions={actions} t={t} />}
    </div>
    {place.kind === 'outdated' && thread.diffHunk !== null && original !== null
      && <Excerpt hunk={thread.diffHunk} side={thread.side} lines={original.endLine - original.startLine + 1} />}
    <div className={css.comments}>
      {thread.comments.map(comment => <Comment key={comment.id} comment={comment} actions={actions} labels={labels} now={now} t={t} />)}
    </div>
    <div className={css.actions}>
      <Button size="sm" onClick={() => { if (!actions.addToInput(thread, range)) actions.inputFailed() }}>
        {t('review.addToInput')}
      </Button>
      {url !== null && <Button size="sm" onClick={() => { actions.openLink(url) }}>
        <IconRightUpOutlineRegular size={14} />{t('thread.openOnHost')}
      </Button>}
    </div>
  </section>
}

/** The end of a recorded diff hunk: the lines a thread was written on and a few before them. */
function Excerpt({ hunk, side, lines }: { readonly hunk: string; readonly side: 'L' | 'R'; readonly lines: number }): ReactNode {
  const excerpt = hunkExcerpt(hunk, side, lines)
  return <div className={css.excerpt}>
    {excerpt.header !== null && <div className={clsx(css.excerptLine, css.excerptHeader)}>{excerpt.header}</div>}
    {excerpt.lines.map((line, index) => <div key={index} className={clsx(css.excerptLine,
      line.startsWith('+') && css.added, line.startsWith('-') && css.deleted)}>{line}</div>)}
  </div>
}

/**
 * Show the whole file at the commit a thread was written on, with the thread's lines marked, under the thread header.
 * Only a new-side thread offers it: its lines number that commit's file.
 */
function OriginalFile({ thread, commit, actions, t }: PropsLocale<typeof NS> & {
  readonly thread: ForgeReviewThread
  readonly commit: string
  readonly actions: ThreadActions
}): ReactNode {
  const [state, setState] = useState<{ readonly lines: readonly string[] } | 'closed' | 'loading' | { readonly failed: string }>('closed')
  const marked = useRef<HTMLDivElement>(null)
  useEffect(() => { marked.current?.scrollIntoView({ block: 'center' }) }, [state])
  const toggle = (): void => {
    if (state !== 'closed' && state !== 'loading') { setState('closed'); return }
    setState('loading')
    void actions.readText(commit, thread.path).then((result) => {
      setState(result.ok ? { lines: result.value.split('\n') } : { failed: result.error.message })
    })
  }
  const open = state !== 'closed'
  const range = thread.original
  return <>
    <button type="button" className={css.link} aria-expanded={open} disabled={state === 'loading'} onClick={toggle}>
      {t(open ? 'thread.hideOriginal' : 'thread.viewOriginal')}
    </button>
    {open && <div className={css.original} role="region" aria-label={t('thread.viewOriginal')}>
      {state === 'loading' ? <div className={css.originalNote}>{t('thread.originalLoading')}</div>
        : 'failed' in state ? <div className={css.originalNote} role="alert">{t('thread.originalFailed', { message: state.failed })}</div>
          : state.lines.map((line, index) => {
            const number = index + 1
            const inside = range !== null && number >= range.startLine && number <= range.endLine
            return <div key={index} ref={inside && number === range.startLine ? marked : undefined}
              className={clsx(css.originalLine, inside && css.marked)}>
              <span className={css.originalNumber}>{number}</span><span>{line}</span>
            </div>
          })}
    </div>}
  </>
}

/**
 * Render the outdated threads of a file after its lines, as one section the reader can fold.
 * @param props - the threads, the shared actions, and copy.
 * @returns the section, or nothing without outdated threads.
 */
export function OutdatedThreads({ threads, actions, t }: PropsLocale<typeof NS> & {
  readonly threads: readonly ForgeReviewThread[]
  readonly actions: ThreadActions
}): ReactNode {
  // The section is folded after the jump with this revision, or -1 before any jump, or null while unfolded.
  const [folded, setFolded] = useState<number | null>(null)
  if (threads.length === 0) return null
  const jump = actions.focused
  const open = folded === null || (jump !== null && jump.revision !== folded && threads.some(thread => thread.id === jump.id))
  return <section className={css.outdated} data-forge-outdated-threads="">
    <div className={css.outdatedHeader}>
      <span>{t('thread.outdatedSection', { count: threads.length })}</span>
      <span className={css.spacer} />
      <button type="button" className={css.link} aria-expanded={open} onClick={() => { setFolded(open ? jump?.revision ?? -1 : null) }}>
        {t(open ? 'thread.collapse' : 'thread.expand')}
        <IconChevronDownOutlineRegular size={12} className={clsx(!open && css.turned)} />
      </button>
    </div>
    {open && threads.map(thread => <ThreadCard key={thread.id} thread={thread} place={{ kind: 'outdated' }} actions={actions} t={t} />)}
  </section>
}
