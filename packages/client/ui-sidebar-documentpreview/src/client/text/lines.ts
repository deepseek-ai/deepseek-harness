/** Source-line helpers shared by the plain renderer and the document scroller. */
import clsx from 'clsx'
import type { DocumentTextPage } from '../document/contract.ts'
import type { TextPage } from '../store.ts'
import css from '../TextPreview.module.css'

/**
 * Split a loaded page into its source lines.
 * @param page - source page.
 * @returns its lines, preserving one empty line but excluding a zero-line page.
 */
export function linesOf(page: TextPage): string[] {
  return page.lines === 0 ? [] : page.text.split('\n')
}

/** Loaded source page with its 1-based start position. */
export type LoadedPage = DocumentTextPage

/**
 * Order loaded pages by source position.
 * @param pages - stored page table.
 * @returns pages in source order.
 */
export function loadedPages(pages: Readonly<Record<number, TextPage>>): LoadedPage[] {
  return Object.entries(pages)
    .map(([offset, page]) => ({ offset: Number(offset), ...page }))
    .sort((left, right) => left.offset - right.offset)
}

/**
 * Find the end of the loaded source prefix.
 * @param pages - ordered pages.
 * @returns the last loaded source line, or zero.
 */
export function lastLineLoaded(pages: readonly LoadedPage[]): number {
  const last = pages.at(-1)
  return last === undefined ? 0 : last.offset + last.lines - 1
}

/**
 * Reveal a plain-text or highlighted source line.
 * @param body - scrolling document body or code-content viewport.
 * @param line - 1-based source line to reveal.
 * @returns The revealed line element, or undefined when the current renderer does not expose that line.
 */
export function scrollToLine(body: HTMLElement, line: number): HTMLElement | undefined {
  const innerCode = body.hasAttribute('data-code-block-content')
  const plain = body.querySelector(`[data-textpreview-line="${line}"]`)
  const code = innerCode ? body.querySelectorAll('pre .line').item(line - 1) : null
  const row = plain ?? code
  if (!(row instanceof HTMLElement)) return undefined
  body.scrollTop = Math.max(0, row.offsetTop)
  return row
}

/**
 * Mark a revealed line with a fading band. The band is a child of the scrollport,
 * not of the line, so a renderer that rebuilds its lines keeps the mark. It
 * replaces an earlier mark and removes itself when its animation ends or when
 * the scrollport is resized, because a resize can reflow the lines above it.
 * @param body - the scrollport that {@link scrollToLine} scrolled.
 * @param row - the line element it returned.
 * @param line - 1-based source line, recorded on the band.
 */
export function markLine(body: HTMLElement, row: HTMLElement, line: number): void {
  clearLineMark(body)
  const mark = body.ownerDocument.createElement('div')
  mark.className = clsx(css.lineMark)
  mark.setAttribute('data-textpreview-mark', String(line))
  mark.style.top = `${row.offsetTop}px`
  mark.style.height = `${row.offsetHeight}px`
  mark.style.width = `${body.scrollWidth}px`
  // The first observation reports the current size; only later ones are resizes.
  let measured = false
  const observer = new ResizeObserver(() => {
    if (measured) dismiss()
    measured = true
  })
  function dismiss(): void {
    observer.disconnect()
    mark.remove()
  }
  mark.addEventListener('animationend', dismiss, { once: true })
  body.append(mark)
  observer.observe(body)
}

/**
 * Remove the scrollport's line mark, for layout changes that move lines without resizing it.
 * @param body - the scrollport that may hold a mark.
 */
export function clearLineMark(body: HTMLElement): void {
  body.querySelector(':scope > [data-textpreview-mark]')?.remove()
}
