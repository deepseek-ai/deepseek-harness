// Tag: read-only capsule badge. The selectable capsule button is `Pill` —
// a tag takes no `onClick` and no `active`, and carries no copy of its own.

import type { ReactNode } from 'react'
import clsx from 'clsx'
import css from './Tag.module.css'

/** Palette selector; each tone names one shipped appearance. */
export type TagTone =
  /** Hairline outline on tertiary text: the read-only default. */
  | 'outline'
  /** Inverted fill: one tag per group that names the current selection. */
  | 'solid'
  /** Platform-gray fill: a neutral fact with no status meaning. */
  | 'neutral'
  /** Text only, no fill: a fact stated more quietly than `neutral`. */
  | 'quiet'
  /** Tinted green: a healthy or enabled state. */
  | 'success'
  /** Tinted blue: informational classification, not health. */
  | 'info'
  /** Tinted amber: attention needed, not yet a failure. */
  | 'warning'
  /** Tinted red: a failure. */
  | 'danger'

/**
 * Render a read-only tag.
 * @param props.tone - which palette to use (default `outline`).
 * @param props.className - extra class for layout placement.
 * @param props.children - the localized label, owned by the render site.
 * @returns the tag element.
 */
export function Tag({ tone = 'outline', className, children }: {
  tone?: TagTone
  // `| undefined` so a caller can forward an optional class straight through
  // under exactOptionalPropertyTypes (a CSS-module lookup is string|undefined).
  className?: string | undefined
  children?: ReactNode
}) {
  return <span className={clsx(css.tag, className)} data-tone={tone}>{children}</span>
}
