/**
 * The body's page arithmetic: how a page's text and line count become lines,
 * how the store's page table becomes the pages in file order, and how far they
 * reach.
 */
import { describe, expect, it } from 'vitest'
import { lastLineLoaded, linesOf, loadedPages } from '../src/client/TextPreview.tsx'
import type { TextPage } from '../src/client/store.ts'

const held = (text: string, lines: number): TextPage => ({ text, lines })

describe('linesOf', () => {
  it('splits on newlines, so a trailing one ends an empty last line as the Host counted it', () => {
    expect(linesOf(held('a\nb', 2))).toEqual(['a', 'b'])
    expect(linesOf(held('a\n', 2))).toEqual(['a', ''])
    expect(linesOf(held('a\nb\n', 3))).toEqual(['a', 'b', ''])
    expect(linesOf(held('a\n\nb', 3))).toEqual(['a', '', 'b'])
  })

  it('tells a page holding one empty line from a page past the file\'s last line by the count', () => {
    expect(linesOf(held('', 1))).toEqual([''])
    expect(linesOf(held('', 0))).toEqual([])
  })
})

describe('loadedPages', () => {
  it('orders the store\'s page table by the line each page starts at', () => {
    expect(loadedPages({})).toEqual([])
    expect(loadedPages({ 4: held('d\ne', 2), 1: held('a\nb\nc', 3) })).toEqual([
      { offset: 1, text: 'a\nb\nc', lines: 3 },
      { offset: 4, text: 'd\ne', lines: 2 },
    ])
  })
})

describe('lastLineLoaded', () => {
  it('is 0 before the first page and the last line of the last page after, by the Host\'s count', () => {
    expect(lastLineLoaded([])).toBe(0)
    expect(lastLineLoaded(loadedPages({ 4: held('d\ne', 2), 1: held('a\nb\nc', 3) }))).toBe(5)
    expect(lastLineLoaded(loadedPages({ 1: held('', 1) }))).toBe(1)
    expect(lastLineLoaded(loadedPages({ 1: held('a', 1), 2: held('', 0) }))).toBe(1)
  })
})
