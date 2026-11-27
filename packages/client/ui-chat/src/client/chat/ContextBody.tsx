// Expanded bodies for the context disclosure, one per durable context form.
// The producer declares the form; this module only chooses a presentation for
// it. Every form falls back to OpaqueBody, which is the documented default for
// an absent, unknown, or malformed form — a resumed or foreign log must render
// even when this UI version has never seen its producer.

import type { ReactNode } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives/client'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { ContextMessageNode } from '../contract/snapshot.ts'
import type { KnownContextForm, SystemMessageSections } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './ContextBody.module.css'

/** Model-facing text stays bounded at the disclosure, not at the producer. */
const MAX_CHARS = 20_000

/** Rows a list body materializes before summarizing the remainder. */
const MAX_ENTRIES = 200

type Translate = ChatViewSlotProps['t']

/** One durable source narrowed to the readable-record shape; null for anything else. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

/** One run of the model-facing content: adjacent text, or one unknown block. */
type ContentRun = { text: string } | { block: unknown }

/**
 * The content blocks as runs, IN THE ORDER the model received them.
 *
 * Adjacent text blocks join with no separator, matching how provider adapters
 * flatten them — inserting a line break would show the reader a line the model
 * never saw. An unknown block breaks the run and keeps its own fallback rather
 * than being hoisted past the text around it or vanishing; the block union is
 * merge-extensible, so a foreign log may interleave shapes this build does not
 * know.
 */
function contentRuns(content: ContextMessageNode['content']): ContentRun[] {
  const runs: ContentRun[] = []
  for (const block of content) {
    if (block.type !== 'text') {
      runs.push({ block })
      continue
    }
    const last = runs[runs.length - 1]
    if (last !== undefined && 'text' in last) last.text += block.text
    else runs.push({ text: block.text })
  }
  return runs
}

/** Only the blocks this UI version does not know, for bodies that replace the text. */
function unknownBlocks(content: ContextMessageNode['content']): unknown[] {
  return contentRuns(content).flatMap(run => 'block' in run ? [run.block] : [])
}

/** The model-facing text, truncated to the display bound. */
function boundedText(text: string, t: Translate): string {
  return text.length > MAX_CHARS
    ? `${text.slice(0, MAX_CHARS)}\n${t('json.truncated', { total: text.length })}`
    : text
}

/**
 * One source field rendered as a value row; nested shapes stay compact JSON.
 * Bounded on its own, because source fields are as unbounded as the text: an unknown
 * producer may record an arbitrarily large string or array.
 */
function fieldValue(value: unknown, t: Translate): string {
  const text = typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)
  return boundedText(text, t)
}

/**
 * Source fields as a key/value list. `kind` is always omitted because the
 * row header already names the producer. `form` is omitted only when a
 * dedicated body rendered for it — then the presentation the reader is looking
 * at IS that value. On the opaque fallback the declaration is kept, because
 * that is the one place a form this version cannot present would otherwise
 * disappear from the UI entirely.
 */
function SourceFields({ source, formRendered, t }: {
  source: unknown
  formRendered: boolean
  t: Translate
}): ReactNode {
  const record = asRecord(source)
  if (record === null) return null
  const hidden = formRendered ? ['kind', 'form'] : ['kind']
  const rows = Object.entries(record).filter(([key]) => !hidden.includes(key))
  if (rows.length === 0) return null
  return (
    <dl className={css.fields} data-context-fields>
      {rows.map(([key, value]) => (
        <div key={key} className={css.field}>
          <dt className={css.fieldKey}>{key}</dt>
          <dd className={css.fieldValue}>{fieldValue(value, t)}</dd>
        </div>
      ))}
    </dl>
  )
}

/**
 * Content blocks this UI version does not know, kept visible rather than
 * dropped: the block union is merge-extensible, so a newer or foreign log may
 * carry a shape this build has no presentation for.
 * @param props - The unrecognized blocks and the locale seat.
 * @returns One generic JSON block per unknown entry.
 */
function UnknownBlocks({ blocks, t }: { blocks: readonly unknown[]; t: Translate }): ReactNode {
  return (
    <>
      {blocks.map((block, index) => (
        <JsonBlock
          key={index}
          label={t('message.unknownBlock')}
          payload={block}
          truncatedLabel={total => t('json.truncated', { total })}
        />
      ))}
    </>
  )
}

/**
 * The model-facing content of one context, shared by every form that shows it:
 * the text with its real line breaks, then any block this UI version does not
 * know, which keeps its own fallback rather than vanishing.
 * @param props - Durable content and the locale seat.
 * @returns The content blocks as the model received them.
 */
function ModelFacingContent({ content, t }: {
  content: ContextMessageNode['content']
  t: Translate
}): ReactNode {
  return (
    <>
      {contentRuns(content).map((run, index) => ('text' in run
        ? run.text !== '' && (
          <pre key={index} className={css.text} data-context-text>{boundedText(run.text, t)}</pre>
        )
        : (
          <JsonBlock
            key={index}
            label={t('message.unknownBlock')}
            payload={run.block}
            truncatedLabel={total => t('json.truncated', { total })}
          />
        )))}
    </>
  )
}

/**
 * Default presentation: the model-facing text as text, with its real line
 * breaks, and the remaining source fields beneath it. This is what every form
 * this UI version does not recognize renders as.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The opaque context body.
 */
export function OpaqueBody({ content, source, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  return (
    <>
      <ModelFacingContent content={content} t={t} />
      <SourceFields source={source} formRendered={false} t={t} />
    </>
  )
}

/** One reconciled instruction file, as the durable source records it. */
interface InstructionChange {
  action: 'set' | 'replace' | 'remove'
  path: string
  digest?: string
}

/**
 * Instruction changes read off the source, or null when the record is not a
 * usable instruction list.
 *
 * The read is all-or-nothing: silently dropping one unreadable entry would show
 * a confident, incomplete file list for a log this version cannot fully read.
 * Paths are deduplicated in first-seen order, matching how the header label is
 * derived from the same array.
 */
function instructionChanges(source: unknown): InstructionChange[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['changes']
  if (!Array.isArray(list)) return null
  const changes: InstructionChange[] = []
  const seen = new Set<string>()
  for (const entry of list as readonly unknown[]) {
    const change = asRecord(entry)
    if (change === null) return null
    const path = change['path']
    if (typeof path !== 'string' || path === '') return null
    const action = change['action']
    // The action decides which word the row shows, so an unrecognized one is
    // not a readable change — it would be presented as loaded or updated.
    if (action !== 'set' && action !== 'replace' && action !== 'remove') return null
    const digest = change['digest']
    if (seen.has(path)) continue
    seen.add(path)
    changes.push({ action, path, ...typeof digest === 'string' ? { digest } : {} })
  }
  return changes.length === 0 ? null : changes
}

/**
 * Locale key for one reconciled file. The baseline loads a file; a later delta
 * distinguishes a newly reconciled path from a rewritten one, which `set` and
 * `replace` already separate at the producer.
 * @param action - the durable change action.
 * @param baseline - whether this context is the startup/resume baseline.
 * @returns the key naming what happened to that file.
 */
function instructionAction(
  action: InstructionChange['action'],
  baseline: boolean,
): 'message.context.instructions.removed' | 'message.context.instructions.loaded'
  | 'message.context.instructions.added' | 'message.context.instructions.updated' {
  if (action === 'remove') return 'message.context.instructions.removed'
  if (baseline) return 'message.context.instructions.loaded'
  return action === 'set' ? 'message.context.instructions.added' : 'message.context.instructions.updated'
}

/**
 * `instructions` form: the files this context reconciled, then their text.
 *
 * The text keeps its `<system-reminder>` framing verbatim — the framing is part
 * of what the model read, so hiding it would misreport the request.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The instructions context body, or the opaque body when the change
 * list is unreadable.
 */
export function InstructionsBody({ content, source, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  const changes = instructionChanges(source)
  if (changes === null) return <OpaqueBody content={content} source={source} t={t} />
  const baseline = asRecord(source)?.['baseline'] === true
  return (
    <>
      <ul className={css.files} data-context-files>
        {changes.map(change => (
          <li key={change.path} className={css.file} title={change.digest}>
            <span className={css.filePath}>{change.path}</span>
            <span className={css.fileAction}>
              {t(instructionAction(change.action, baseline))}
            </span>
          </li>
        ))}
      </ul>
      <ModelFacingContent content={content} t={t} />
    </>
  )
}

/** One catalog entry, as the durable source records it. */
interface CatalogEntry {
  name: string
  description: string
}

/**
 * Catalog entries read off the source, or null when the record is not a usable
 * catalog. All-or-nothing for the same reason as the instruction list: this body
 * replaces the model-facing text, so a partial list would hide the only complete
 * account of what the model read.
 */
function catalogEntries(source: unknown): CatalogEntry[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['entries']
  if (!Array.isArray(list)) return null
  const entries: CatalogEntry[] = []
  for (const item of list as readonly unknown[]) {
    const entry = asRecord(item)
    if (entry === null) return null
    const name = entry['name']
    const description = entry['description']
    if (typeof name !== 'string' || name === '' || typeof description !== 'string') return null
    entries.push({ name, description })
  }
  // An empty list is a real catalog: a replacement with no entries retires
  // every earlier name. Only an unreadable shape falls back.
  return entries
}

/**
 * `catalog` form: the published entries as a list, read from the source rather
 * than re-parsed out of the model-facing prose.
 *
 * A catalog whose source carries no usable entries falls through to the opaque
 * body, so an older or hand-edited log still shows its text.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The catalog context body, or the opaque body when the entry list is
 * unreadable.
 */
export function CatalogBody({ content, source, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  const entries = catalogEntries(source)
  if (entries === null) return <OpaqueBody content={content} source={source} t={t} />
  const update = asRecord(source)?.['update'] === true
  // Entry count is unbounded (a provider may publish any number of skills), and
  // the scrollport bounds height, not node count — so the list bounds itself.
  const shown = entries.slice(0, MAX_ENTRIES)
  const rest = unknownBlocks(content)
  return (
    <>
      {update && <p className={css.catalogNotice} data-context-catalog-update>{t('message.context.catalog.replaced')}</p>}
      <ul className={css.entries} data-context-entries>
        {shown.map((entry, index) => (
          // Index key: a hand-edited or foreign log may repeat a name, and a
          // duplicate React key would drop a row the model did see.
          <li key={index} className={css.entry}>
            <code className={css.entryName}>{entry.name}</code>
            <span className={css.entryDescription}>{entry.description}</span>
          </li>
        ))}
      </ul>
      {shown.length < entries.length && (
        <p className={css.catalogNotice} data-context-entries-truncated>
          {t('message.context.catalog.more', { count: entries.length - shown.length })}
        </p>
      )}
      {/* The block union is merge-extensible: a catalog message carrying an
          unknown block still shows it rather than dropping model-visible content. */}
      <UnknownBlocks blocks={rest} t={t} />
    </>
  )
}

/** One named contribution to a runtime snapshot, as the durable source records it. */
interface SnapshotSection {
  name: string
  text: string
}

/** Snapshot sections read off the source, or null when the record is unusable. */
function snapshotSections(source: unknown): SnapshotSection[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['sections']
  if (!Array.isArray(list)) return null
  const sections: SnapshotSection[] = []
  for (const item of list as readonly unknown[]) {
    const section = asRecord(item)
    if (section === null) return null
    const name = section['name']
    const text = section['text']
    if (typeof name !== 'string' || name === '' || typeof text !== 'string') return null
    sections.push({ name, text })
  }
  return sections.length === 0 ? null : sections
}

/**
 * `snapshot` form: the named contributions this snapshot assembled, in order.
 *
 * The sections are the same bytes the model read, split at the boundaries the
 * producer assembled them on, so a reader sees which subsystem contributed
 * which state instead of one undifferentiated wall.
 *
 * One sentence of the model-facing text is NOT in any section: the producer's
 * framing line declaring that this snapshot supersedes earlier ones. Unlike the
 * `<system-reminder>` wrapper an instruction context carries — which wraps
 * content and cannot be separated from it — that line states the form's own
 * semantics, so the body states them as a caption instead of reprinting the
 * joined prose beside the sections it was split from.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The snapshot context body, or the opaque body when unreadable.
 */
export function SnapshotBody({ content, source, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  const sections = snapshotSections(source)
  /* v8 ignore next -- contextBody reads the sections before choosing this body. */
  if (sections === null) return <OpaqueBody content={content} source={source} t={t} />
  return (
    <>
      <p className={css.catalogNotice} data-context-snapshot-supersedes>
        {t('message.context.snapshot.supersedes')}
      </p>
      <dl className={css.sections} data-context-sections>
        {sections.map((section, index) => (
          <div key={index} className={css.section}>
            <dt className={css.sectionName}>{section.name}</dt>
            <dd className={css.sectionText}>{boundedText(section.text, t)}</dd>
          </div>
        ))}
      </dl>
    </>
  )
}

/**
 * One incremental system message split by the sources it names, in the order the model read them:
 * what each source did, the notices attached to it, then the text the message carries for it.
 * @param props - Section-attributed reading of the message and the locale seat.
 * @returns The system update body.
 */
export function SystemSectionsBody({ message, t }: { message: SystemMessageSections; t: Translate }): ReactNode {
  return (
    <>
      {message.reset && (
        <p className={css.catalogNotice} data-system-reset>{t('message.systemPromptReset')}</p>
      )}
      {message.notices.map((notice, index) => (
        <p key={index} className={css.catalogNotice} data-system-notice>{boundedText(notice, t)}</p>
      ))}
      <dl className={css.sections} data-system-sections>
        {message.changes.map(change => (
          <div key={change.name} className={css.section} data-system-section={change.change}>
            <dt className={css.sectionName}>{t(`message.systemSection.${change.change}`, { name: change.name })}</dt>
            {change.notices.map((notice, index) => (
              <dd key={index} className={css.sectionNotice} data-system-notice>{boundedText(notice, t)}</dd>
            ))}
            {change.text !== '' && <dd className={css.sectionText}>{boundedText(change.text, t)}</dd>}
          </div>
        ))}
      </dl>
    </>
  )
}

/**
 * `notice` form: what just happened, with the model-facing text beneath it.
 *
 * The one-line account also rides the collapsed row ({@link contextBody}), so a
 * notice is usually readable without expanding at all.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The notice context body.
 */
export function NoticeBody({ content, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  return <ModelFacingContent content={content} t={t} />
}

/**
 * `relay` form: which agent sent this, then what it said.
 *
 * The sender is an opaque session id; it is shown as a field rather than a
 * label, because this client cannot resolve it to a title.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The relay context body.
 */
export function RelayBody({ content, source, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  const sender = relaySender(source)
  /* v8 ignore next -- contextBody resolves the sender before choosing this body. */
  if (sender === null) return <OpaqueBody content={content} source={source} t={t} />
  return (
    <>
      <p className={css.relaySender} data-context-relay-sender>
        {t('message.context.relay.from', { session: sender })}
      </p>
      <ModelFacingContent content={content} t={t} />
    </>
  )
}

/** The sending agent's session id, or null when the record does not name one. */
function relaySender(source: unknown): string | null {
  const sender = asRecord(source)?.['senderSessionId']
  return typeof sender === 'string' && sender !== '' ? sender : null
}

/** One recalled session, as the durable source records it. */
interface RecalledSession {
  label: string
  retained: number
  omitted: number
  truncated: boolean
}

/** Recalled sessions read off the source, or null when the record is unusable. */
function recalledSessions(source: unknown): RecalledSession[] | null {
  const record = asRecord(source)
  const list = record === null ? undefined : record['references']
  if (!Array.isArray(list)) return null
  const sessions: RecalledSession[] = []
  for (const item of list as readonly unknown[]) {
    const reference = asRecord(item)
    if (reference === null) return null
    const label = reference['label']
    const retained = reference['retainedMessages']
    const omitted = reference['omittedMessages']
    const truncated = reference['truncated']
    // Completeness is the fact this card exists to report, so a reference that
    // cannot state it is not a readable recall — showing the label alone would
    // present a confident card over unknown loss.
    if (typeof label !== 'string' || label === ''
      || typeof retained !== 'number' || typeof omitted !== 'number'
      || typeof truncated !== 'boolean') return null
    sessions.push({ label, retained, omitted, truncated })
  }
  return sessions.length === 0 ? null : sessions
}

/**
 * `recall` form: which sessions this material came from and how much of each
 * survived the read, then the material itself.
 *
 * Completeness is the fact a reader needs first: recalled context is bounded on
 * the way in, so a card that hid the omitted count would overstate what the
 * model received.
 * @param props - Durable content, its source, and the locale seat.
 * @returns The recall context body, or the opaque body when unreadable.
 */
export function RecallBody({ content, source, t }: {
  content: ContextMessageNode['content']
  source: unknown
  t: Translate
}): ReactNode {
  const sessions = recalledSessions(source)
  if (sessions === null) return <OpaqueBody content={content} source={source} t={t} />
  return (
    <>
      <ul className={css.recalls} data-context-recalls>
        {sessions.map((session, index) => (
          <li key={index} className={css.recall}>
            <span className={css.recallLabel}>{session.label}</span>
            <span className={css.recallCounts}>
              {t('message.context.recall.counts', {
                retained: session.retained,
                omitted: session.omitted,
              })}
            </span>
            {session.truncated && (
              <span className={css.recallCounts}>{t('message.context.recall.truncated')}</span>
            )}
          </li>
        ))}
      </ul>
      <ModelFacingContent content={content} t={t} />
    </>
  )
}

/** The one-line account a `notice` puts on its collapsed row, when it records one. */
function noticeSummary(source: unknown): string | null {
  const summary = asRecord(source)?.['summary']
  return typeof summary === 'string' && summary !== '' ? summary : null
}

/**
 * Choose the body for one context node.
 *
 * Returns the form the body actually rendered as, which is not always the
 * declared one: a declared form whose fields are unreadable falls back to
 * opaque, and the caller labels the row with what it really shows.
 * `summary` is the collapsed row's one-line account, which only a `notice`
 * records: its whole point is being readable without expanding.
 * @param form - the producer-declared form projected onto the node.
 * @param props - durable content, its source, and the locale seat.
 * @returns the rendered form (null for opaque), its collapsed summary, and its body.
 */
export function contextBody(
  form: ContextMessageNode['form'],
  props: { content: ContextMessageNode['content']; source: unknown; t: Translate },
): { rendered: KnownContextForm | null; summary: string | null; body: ReactNode } {
  const opaque = { rendered: null, summary: null, body: <OpaqueBody {...props} /> }
  switch (form) {
    case 'instructions':
      return instructionChanges(props.source) === null
        ? opaque
        : { rendered: 'instructions', summary: null, body: <InstructionsBody {...props} /> }
    case 'catalog':
      return catalogEntries(props.source) === null
        ? opaque
        : { rendered: 'catalog', summary: null, body: <CatalogBody {...props} /> }
    case 'snapshot':
      return snapshotSections(props.source) === null
        ? opaque
        : { rendered: 'snapshot', summary: null, body: <SnapshotBody {...props} /> }
    case 'notice': {
      const summary = noticeSummary(props.source)
      return summary === null
        ? opaque
        : { rendered: 'notice', summary, body: <NoticeBody {...props} /> }
    }
    case 'relay':
      return relaySender(props.source) === null
        ? opaque
        : { rendered: 'relay', summary: null, body: <RelayBody {...props} /> }
    case 'recall':
      return recalledSessions(props.source) === null
        ? opaque
        : { rendered: 'recall', summary: null, body: <RecallBody {...props} /> }
    case null:
      return opaque
    /* v8 ignore next 4 -- closed-union backstop; the compiler rejects a new
    KnownContextForm here rather than letting it degrade to opaque silently. */
    default: {
      const unreachable: never = form
      throw new Error(`unreachable context form: ${String(unreachable)}`)
    }
  }
}
