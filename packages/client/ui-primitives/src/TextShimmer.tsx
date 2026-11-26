/** Text activity animation shared by a row and its nested text fragments. */
import { createContext, memo, useContext, type ReactNode } from 'react'
import clsx from 'clsx'
import css from './TextShimmer.module.css'

const DecorativeCopy = createContext<boolean | undefined>(undefined)

/**
 * Inert attribute for the decorative copy. React 18 forwards `inert` only as a string, and React 19
 * treats an empty string as false; a non-empty string sets the attribute under both. Typed `object`
 * because React 18's DOM types omit `inert` and React 19's declare it boolean.
 */
const INERT: object = { inert: 'inert' }

/** Text and activity supplied by the owning row. */
export interface TextShimmerProps {
  /** Text or presentational children with text in nested TextShimmer instances. No effects or element ids. */
  children: ReactNode
  /** Whether to animate; nested instances share the containing row's activity. */
  active?: boolean | undefined
  className?: string | undefined
  /** Layout class applied equally to the base and decorative content. */
  contentClassName?: string | undefined
}

function TextContent({ children, className }: Pick<TextShimmerProps, 'children' | 'className'>) {
  const decorative = useContext(DecorativeCopy)
  const generated = decorative === true && typeof children === 'string'
  return (
    <span className={clsx(css.text, className)} data-shimmer-text={generated ? children : undefined}>
      {generated ? null : children}
    </span>
  )
}

/**
 * Render text with one shared highlight while retaining selectable, accessible content.
 * Nested instances inherit the outer animation. Keep icons outside; mark decorative
 * separators with data-shimmer-decoration so their background follows the highlight.
 * Active children also render in an inert, clipped decoration; supply only presentation.
 * @param props - localized text, running state, and owner styling.
 * @returns retained text and its optional decorative highlight.
 */
export const TextShimmer = memo(function TextShimmer({ children, active = false, className, contentClassName }: TextShimmerProps) {
  const decorative = useContext(DecorativeCopy)
  if (decorative !== undefined) return <TextContent className={className}>{children}</TextContent>
  const content = typeof children === 'string' ? <TextContent>{children}</TextContent> : children
  return (
    <span className={clsx(css.root, className)} data-shimmer={active || undefined}>
      <DecorativeCopy.Provider value={false}>
        <span className={clsx(css.content, contentClassName)}>{content}</span>
      </DecorativeCopy.Provider>
      {active && (
        <span className={css.decoration} aria-hidden="true" {...INERT}>
          <span className={css.sweep}>
            <DecorativeCopy.Provider value>
              <span className={clsx(css.content, css.highlight, contentClassName)}>{content}</span>
            </DecorativeCopy.Provider>
          </span>
        </span>
      )}
    </span>
  )
})
