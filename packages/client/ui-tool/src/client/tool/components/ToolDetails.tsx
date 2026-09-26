/** Compact, read-only fields and lists for recorded Tool results. */
import {
  CodeBlock, MarkdownText, IconCheckOutlineRegular, IconChevronRightOutlineRegular, IconPlayOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { OpenFileOptions } from '@deepseek-ai/dsh-client-ui-chat/client'
import { codeToolbarLabels, markdownLabels } from '../models/primitive-labels.ts'
import css from './ToolDetails.module.css'

/** One recorded entity, receipt, or collapsible group of related values. */
export interface ToolDetailItem {
  title?: string
  subtitle?: string
  description?: string
  badge?: { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'error' }
  status?: { value: 'completed' | 'in_progress' | 'pending'; label: string }
  previousStatus?: string
  change?: { value: 'added' | 'removed' | 'updated'; label: string }
  fields: readonly { label: string; value: string }[]
  lines?: readonly string[]
  markdown?: string
  code?: { text: string; language?: string }
  location?: { path: string; line?: number }
  groups?: readonly { label: string; items: readonly ToolDetailItem[] }[]
}

/** Localized display data shared by the built-in detail cards. */
export interface ToolDetailsModel {
  items: readonly ToolDetailItem[]
  summary?: string
  /** Header text while expanded, omitting a receipt status shown in the body. */
  expandedSummary?: string
  empty?: string
  caption?: string
  unchanged?: { label: string; items: ToolDetailsModel['items'] }
}

interface DetailContentProps {
  t: TranslateNS<'conversation'>
  onOpenFile?: ((path: string, options?: OpenFileOptions) => void) | undefined
}

function DetailItem({ item, t, onOpenFile }: { item: ToolDetailItem } & DetailContentProps) {
  const status = item.status
  return (
    <li className={css.item} data-change={item.change?.value}>
      {item.title !== undefined && (
        <div className={css.heading}>
          {status !== undefined && (
            <span className={css.status} role="img" aria-label={item.change?.label ?? status.label}>
              {item.change?.value === 'added' ? '+'
                : item.change?.value === 'removed' ? '−'
                  : status.value === 'completed' ? <IconCheckOutlineRegular size={14} />
                    : status.value === 'in_progress' ? <IconPlayOutlineRegular size={14} />
                      : <span className={css.pending} />}
            </span>
          )}
          {item.location !== undefined && onOpenFile !== undefined ? (
            <button className={css.path} type="button" onClick={() => {
              const location = item.location
              if (location !== undefined) onOpenFile(location.path, location.line === undefined ? undefined : { line: location.line })
            }}>{item.title}</button>
          ) : <span className={css.text}>{item.title}</span>}
          {item.badge !== undefined && <span className={css.badge} data-tone={item.badge.tone}>{item.badge.label}</span>}
          {status !== undefined && (
            <span className={css.statusText}>
              {item.previousStatus !== undefined && (
                <><span className={css.previous}>{item.previousStatus}</span><span> → </span></>
              )}
              <span>{status.label}</span>
              {item.change?.value === 'updated' && item.previousStatus === undefined && <span> · {item.change.label}</span>}
            </span>
          )}
        </div>
      )}
      {item.subtitle !== undefined && <div className={css.subtitle}>{item.subtitle}</div>}
      {item.description !== undefined && <p className={css.description}>{item.description}</p>}
      {item.fields.length > 0 && (
        <dl className={css.fields}>
          {item.fields.map(field => (
            <div key={field.label} className={css.field}>
              <dt>{field.label}</dt>
              <dd>{field.value}</dd>
            </div>
          ))}
        </dl>
      )}
      {item.lines !== undefined && <ul className={css.lines}>{item.lines.map((line, index) => <li key={index}>{line}</li>)}</ul>}
      {item.markdown !== undefined && <div className={css.prose}><MarkdownText text={item.markdown} labels={markdownLabels(t)} /></div>}
      {item.code !== undefined && (
        <CodeBlock
          toolbarLabels={codeToolbarLabels(t)}
          className={css.code} code={item.code.text} lang={item.code.language}
          copyLabel={t('copy')} copiedLabel={t('copied')}
        />
      )}
      {item.groups?.map((group, index) => (
        <details key={index} className={css.group}>
          <summary><IconChevronRightOutlineRegular /><span>{group.label}</span></summary>
          <ul className={css.list}>
            {group.items.map((child, childIndex) => <DetailItem key={childIndex} item={child} t={t} onOpenFile={onOpenFile} />)}
          </ul>
        </details>
      ))}
    </li>
  )
}

/**
 * Render recorded values with local disclosures, copy controls, and file navigation.
 * @param props.model - Localized fields or list items; an empty list uses its empty label.
 * @param props.hasInspect - Reserve space for the row's upper-right Inspect button.
 * @param props.t - Conversation dictionary for shared Markdown and code controls.
 * @param props.onOpenFile - Open a recorded file location in the session workspace.
 * @returns The expanded detail body.
 */
export function ToolDetails({ model, hasInspect = false, t, onOpenFile }: {
  model: ToolDetailsModel
  hasInspect?: boolean
} & DetailContentProps) {
  return (
    <div className={css.root} data-inspect={hasInspect || undefined} data-caption={model.caption !== undefined || undefined}>
      {model.caption !== undefined && <div className={css.caption}>{model.caption}</div>}
      {model.items.length === 0 ? <p className={css.empty}>{model.empty}</p> : (
        <ul className={css.list}>
          {model.items.map((item, index) => <DetailItem key={index} item={item} t={t} onOpenFile={onOpenFile} />)}
        </ul>
      )}
      {model.unchanged !== undefined && (
        <details className={css.unchanged}>
          <summary><IconChevronRightOutlineRegular />{model.unchanged.label}</summary>
          <ul className={css.list}>
            {model.unchanged.items.map((item, index) => <DetailItem key={index} item={item} t={t} onOpenFile={onOpenFile} />)}
          </ul>
        </details>
      )}
    </div>
  )
}
