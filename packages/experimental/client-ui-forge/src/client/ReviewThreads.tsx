/**
 * Review threads of a change request inside the changes view: a thread card at its lines or at the top of its file, a
 * resolved thread folded into one row, and the outdated threads of a file in a section after its lines. A card offers
 * the writes the signed-in user may make: a reply, published at once or added to the pending review, resolving or
 * unresolving the thread, and editing or deleting the user's own comments.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconCheckOutlineRegular, IconChevronDownOutlineRegular, IconEllipsisOutlineRegular, IconRightUpOutlineRegular, MarkdownText,
  Menu, Tag, Tooltip, type MarkdownLabels,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ForgeReviewComment, ForgeReviewThread, ForgeReviewWrite, ForgeThreadId } from '@deepseek-ai/dsh-experimental-forge/types'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import { formatAgo } from './format.ts'
import { anchorRange, hunkExcerpt, type ThreadPlace } from './review-threads.ts'
import { SplitAction } from './ReviewComposer.tsx'
import type { NS } from './locales.ts'
import css from './ReviewThreads.module.css'
import composerCss from './ReviewComposer.module.css'

type Translate = PropsLocale<typeof NS>['t']

/** Each member of a union without its `headSha`. */
type WithoutHead<T> = T extends unknown ? Omit<T, 'headSha'> : never

/** A write to one thread or its comments, without the head commit the changes view adds. */
export type ThreadWrite = WithoutHead<Extract<ForgeReviewWrite, { readonly kind: 'reply' | 'resolve' | 'edit-comment' | 'delete-comment' }>>

/** Writes the signed-in user can make to the threads of one changes view. */
export interface ThreadWrites {
  /** Send a write; resolves to the message to show, or undefined once the code host took it. */
  readonly write: (write: ThreadWrite) => Promise<string | undefined>
  /** Whether the user has a pending review, which every reply then joins. */
  readonly reviewStarted: boolean
  /** Whether the user can add a reply to a pending review, starting one when needed. */
  readonly canReview: boolean
}

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
  /** Writes the user can make, or null when the code host takes none from this view. */
  readonly writes: ThreadWrites | null
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

/** Run one write at a time for a card section, keeping its error until the next attempt. */
function useWriting(t: Translate): {
  readonly busy: boolean
  readonly error: string | null
  readonly run: (send: () => Promise<string | undefined>) => Promise<boolean>
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const running = useRef(false)
  const run = async (send: () => Promise<string | undefined>): Promise<boolean> => {
    if (running.current) return false
    running.current = true
    setBusy(true)
    setError(null)
    try {
      const failure = await send()
      setError(failure ?? null)
      return failure === undefined
    } catch (_error) {
      setError(t('thread.writeUnknown'))
      return false
    } finally {
      running.current = false
      setBusy(false)
    }
  }
  return { busy, error, run }
}

/** A plain-text field with Cancel and the actions that send it, for a reply or a comment edit. */
function TextForm({ label, initial, busy, error, cancel, children }: {
  readonly label: string
  readonly initial: string
  readonly busy: boolean
  readonly error: string | null
  readonly cancel: { readonly label: string; readonly run: () => void }
  /** The sending actions, given the current text and whether it is blank. */
  readonly children: (text: string, blank: boolean) => ReactNode
}): ReactNode {
  const [text, setText] = useState(initial)
  return <div className={css.form}>
    <textarea autoFocus className={composerCss.input} rows={3} value={text} disabled={busy} aria-label={label} placeholder={label}
      onChange={(event) => { setText(event.target.value) }} />
    {error !== null && <div className={composerCss.error} role="alert">{error}</div>}
    <div className={css.formActions}>
      <Button size="sm" className={clsx(composerCss.cancel)} disabled={busy} onClick={cancel.run}>{cancel.label}</Button>
      {children(text, text.trim() === '')}
    </div>
  </div>
}

/** Tells the card which of its forms hold text the reader is writing, so it does not fold them away. */
type Drafting = (form: string, active: boolean) => void

function Comment({ comment, last, actions, labels, now, drafting, t }: {
  readonly comment: ForgeReviewComment
  readonly drafting: Drafting
  /** Whether the comment is the only one of its thread, so deleting it deletes the thread. */
  readonly last: boolean
  readonly actions: ThreadActions
  readonly labels: MarkdownLabels
  readonly now: number
  readonly t: Translate
}): ReactNode {
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view')
  useEffect(() => {
    drafting(comment.id, mode === 'edit')
    return () => { drafting(comment.id, false) }
  }, [drafting, comment.id, mode])
  const [menu, setMenu] = useState(false)
  const writing = useWriting(t)
  const writes = actions.writes
  const login = comment.author?.login ?? null
  const editable = writes !== null && comment.viewerCanEdit
  const deletable = writes !== null && comment.viewerCanDelete
  const menuLabel = t('thread.commentActions', { author: login ?? t('thread.deletedAuthor') })
  const send = async (write: ThreadWrite): Promise<void> => {
    if (writes !== null && await writing.run(() => writes.write(write))) setMode('view')
  }
  return <div className={css.comment} data-forge-thread-comment={comment.id}>
    <Avatar author={comment.author} />
    <div className={css.commentMain}>
      <div className={css.commentHeader}>
        <span className={css.login}>{login ?? t('thread.deletedAuthor')}</span>
        <span className={css.time} title={comment.createdAt}>{formatAgo(comment.createdAt, now, t) ?? comment.createdAt}</span>
        {login !== null && login === actions.author && <Tag tone="outline">{t('thread.author')}</Tag>}
        {comment.author?.bot === true && <Tag tone="outline">{t('thread.bot')}</Tag>}
        {comment.pending && <Tag tone="warning">{t('review.pending')}</Tag>}
        {(editable || deletable) && mode === 'view' && <>
          <span className={css.spacer} />
          <Menu open={menu} portal dense align="end" autoFocus onClose={() => { setMenu(false) }}
            items={[...editable ? [{ id: 'edit', label: t('review.edit') }] : [], ...deletable ? [{ id: 'delete', label: t('review.remove') }] : []]}
            onSelect={(id) => { setMenu(false); setMode(id === 'edit' ? 'edit' : 'delete') }}
            anchor={<span className={css.menuAnchor}><Tooltip label={menuLabel} side="bottom">
              <button type="button" className={css.icon} aria-label={menuLabel} aria-haspopup="menu" aria-expanded={menu}
                onClick={() => { setMenu(value => !value) }}><IconEllipsisOutlineRegular size={14} /></button>
            </Tooltip></span>} />
        </>}
      </div>
      {mode === 'edit'
        ? <TextForm label={t('thread.editAria')} initial={comment.body} busy={writing.busy} error={writing.error}
          cancel={{ label: t('review.cancel'), run: () => { setMode('view') } }}>
          {(text, blank) => <Button size="sm" variant="primary" disabled={writing.busy || blank || text === comment.body}
            onClick={() => { void send({ kind: 'edit-comment', comment: comment.id, body: text }) }}>
            {t(writing.busy ? 'thread.saving' : 'thread.save')}
          </Button>}
        </TextForm>
        // Raw HTML renders nothing, as GitHub hides comments and unknown tags, and never enters the DOM.
        : <div className={css.body}><MarkdownText text={comment.body} labels={labels} variant="body" omitHtml /></div>}
      {mode === 'delete' && <div className={css.confirm} role="group" aria-label={t(last ? 'thread.deleteLast' : 'thread.deleteConfirm')}>
        <span className={css.confirmText}>{t(last ? 'thread.deleteLast' : 'thread.deleteConfirm')}</span>
        <Button size="sm" disabled={writing.busy} onClick={() => { setMode('view') }}>{t('review.cancel')}</Button>
        <Button size="sm" variant="primary" disabled={writing.busy} onClick={() => { void send({ kind: 'delete-comment', comment: comment.id }) }}>
          {t(writing.busy ? 'thread.deleting' : 'review.remove')}
        </Button>
        {writing.error !== null && <div className={clsx(composerCss.error, css.confirmError)} role="alert">{writing.error}</div>}
      </div>}
    </div>
  </div>
}

/**
 * The reply field of a thread. Without a pending review it replies at once, and its menu starts one with the reply; with
 * one, it adds the reply to it, since GitHub adds every reply of the user to the pending review.
 */
function Reply({ thread, writes, drafting, t }: PropsLocale<typeof NS> & {
  readonly thread: ForgeReviewThread
  readonly writes: ThreadWrites
  readonly drafting: Drafting
}): ReactNode {
  const [open, setOpen] = useState(false)
  useEffect(() => {
    drafting('reply', open)
    return () => { drafting('reply', false) }
  }, [drafting, open])
  const writing = useWriting(t)
  if (!open) {
    return <button type="button" className={css.replyPrompt} onClick={() => { setOpen(true) }}>{t('thread.replyPlaceholder')}</button>
  }
  const send = async (text: string, pending: boolean): Promise<void> => {
    if (await writing.run(() => writes.write({ kind: 'reply', thread: thread.id, body: text, pending }))) setOpen(false)
  }
  return <TextForm label={t('thread.replyPlaceholder')} initial="" busy={writing.busy} error={writing.error}
    cancel={{ label: t('review.cancel'), run: () => { setOpen(false) } }}>
    {(text, blank) => writes.reviewStarted
      ? <Button size="sm" variant="primary" disabled={writing.busy || blank} onClick={() => { void send(text, true) }}>
        {t(writing.busy ? 'review.publishing' : 'review.queue')}
      </Button>
      : <SplitAction disabled={writing.busy || blank} label={t(writing.busy ? 'review.publishing' : 'thread.reply')}
        run={() => { void send(text, false) }} menuLabel={t('thread.replyActions')}
        other={writes.canReview ? t('review.startReview') : undefined} menu={() => { void send(text, true) }} />}
  </TextForm>
}

/** Resolve or unresolve a thread. */
function Resolution({ thread, writes, t }: PropsLocale<typeof NS> & {
  readonly thread: ForgeReviewThread
  readonly writes: ThreadWrites
}): ReactNode {
  const writing = useWriting(t)
  return <>
    <Button size="sm" disabled={writing.busy}
      onClick={() => { void writing.run(() => writes.write({ kind: 'resolve', thread: thread.id, resolved: !thread.resolved })) }}>
      {t(thread.resolved ? 'thread.unresolve' : 'thread.resolve')}
    </Button>
    {writing.error !== null && <div className={clsx(composerCss.error, css.actionError)} role="alert">{writing.error}</div>}
  </>
}

/**
 * Render one thread: its place, every comment, its reply field, and its actions. A resolved thread folds into one row
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
  // A thread resolved elsewhere while the reader writes a reply or an edit stays open, so the text is not lost.
  const [drafts, setDrafts] = useState<ReadonlySet<string>>(() => new Set())
  const drafting = useCallback<Drafting>((form, active) => {
    setDrafts((value) => {
      if (value.has(form) === active) return value
      const next = new Set(value)
      if (active) next.add(form)
      else next.delete(form)
      return next
    })
  }, [])
  const unfolded = open || !thread.resolved || focused || drafts.size > 0
  const side = place.kind === 'line' ? place.side : thread.side
  const original = place.kind === 'outdated' && thread.original !== null ? thread.original : null
  // The composer names an outdated thread by the lines it was written on, as its label does.
  const range = place.kind === 'line' ? anchorRange(place.side, place) : original !== null ? anchorRange(thread.side, original) : null
  const commit = writtenOn(thread)
  const first = thread.comments[0]
  const url = first?.url ?? null
  const writes = actions.writes
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
      {thread.comments.map(comment => <Comment key={comment.id} comment={comment} last={thread.comments.length === 1}
        actions={actions} labels={labels} now={now} drafting={drafting} t={t} />)}
    </div>
    {writes !== null && thread.viewerCanReply && <Reply thread={thread} writes={writes} drafting={drafting} t={t} />}
    <div className={css.actions}>
      <Button size="sm" onClick={() => { if (!actions.addToInput(thread, range)) actions.inputFailed() }}>
        {t('review.addToInput')}
      </Button>
      {url !== null && <Button size="sm" onClick={() => { actions.openLink(url) }}>
        <IconRightUpOutlineRegular size={14} />{t('thread.openOnHost')}
      </Button>}
      {writes !== null && thread.viewerCanResolve && <Resolution thread={thread} writes={writes} t={t} />}
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
