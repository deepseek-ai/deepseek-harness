/**
 * The label of a changed file in the files menu, the local changes list, and a
 * file's header: its name, then its directory in smaller subdued type, with the
 * complete path in a tooltip.
 */

import type { ReactNode } from 'react'
import clsx from 'clsx'
import { Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import css from './FileLabel.module.css'

/** Characters at the end of a name or directory that stay whole while its start shortens. */
const KEPT_END = 12

/** Shortest start worth shortening; a text this much longer than its kept end is split. */
const MIN_START = 4

/** Hover delay before the complete path shows, so moving across a list does not flash it. */
const TOOLTIP_DELAY_MS = 400

/** Split off the end that stays whole, by characters so a surrogate pair is never cut. */
function partsOf(text: string): { readonly start: string; readonly end: string } {
  const characters = Array.from(text)
  if (characters.length <= KEPT_END + MIN_START) return { start: text, end: '' }
  return { start: characters.slice(0, -KEPT_END).join(''), end: characters.slice(-KEPT_END).join('') }
}

/** One text whose start ends in an ellipsis when space runs out, while its end stays whole. */
function Shortened({ text, className }: { readonly text: string; readonly className: string | undefined }): ReactNode {
  const { start, end } = partsOf(text)
  return (
    <span className={clsx(css.shortened, className)}>
      <span className={css.head}>{start}</span>
      {end !== '' && <span className={css.tail}>{end}</span>}
    </span>
  )
}

/**
 * Render a changed file's name and directory. The directory gives up its space
 * before the name does; assistive technology reads the complete path.
 * @param props.path - the file's path in the repository.
 * @param props.tooltip - the hover text, such as both paths of a renamed file; defaults to the path.
 * @param props.className - class of the outer element, which callers size within their row.
 * @returns the label.
 */
export function FileLabel({ path, tooltip, className }: {
  readonly path: string
  readonly tooltip?: string | undefined
  readonly className?: string | undefined
}): ReactNode {
  const { directory, name } = pathPartsOf(path)
  const folder = directory.replace(/[/\\]$/, '')
  return (
    <Tooltip label={tooltip ?? path} side="bottom" portal delayMs={TOOLTIP_DELAY_MS} maxWidth={360}>
      <span className={clsx(css.label, className)} data-forge-file-label="">
        <span className={css.parts} aria-hidden="true">
          <Shortened text={name} className={css.name} />
          {folder !== '' && <Shortened text={folder} className={css.directory} />}
        </span>
        <span className={css.visuallyHidden}>{path}</span>
      </span>
    </Tooltip>
  )
}
