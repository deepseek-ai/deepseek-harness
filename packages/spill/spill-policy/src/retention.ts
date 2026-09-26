/** Ordered head/tail retention of text and indivisible images. @module @deepseek-ai/dsh-spill-policy/retention */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

/** Content whose text can be split and whose images must remain whole. */
export type RetainableBlock = Extract<ContentBlock, { type: 'text' | 'image' }>

/** Retained ends and exact quantities excluded from their original sequence. */
export interface RetainedContent {
  head: RetainableBlock[]
  tail: RetainableBlock[]
  omittedBytes: number
  omittedImages: number
}

/** Preserve a UTF-16 code point when a text budget cuts between its surrogates. */
function textSlice(text: string, length: number, tail: boolean): string {
  let cut = tail ? text.length - length : length
  const previous = text.charCodeAt(cut - 1)
  const current = text.charCodeAt(cut)
  if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff) {
    cut += tail ? 1 : -1
  }
  return tail ? text.slice(cut) : text.slice(0, cut)
}

/** Largest contiguous text end fitting a monotonic token estimate. */
function fitText(text: string, budget: number, tail: boolean, price: (block: RetainableBlock) => number): string {
  let low = 0
  let high = text.length
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    const candidate = textSlice(text, middle, tail)
    if (candidate.length === 0 || price({ type: 'text', text: candidate }) <= budget) low = middle
    else high = middle - 1
  }
  return textSlice(text, low, tail)
}

/**
 * Retain contiguous ends without moving or partially retaining an image.
 * Each end receives half the content budget; unused space at an indivisible
 * image stays unused. Text pricing must be monotonic in retained length.
 * @param content - ordered text and image blocks whose total price exceeds budget.
 * @param budget - non-negative integer token budget after reserving notices.
 * @param price - model-route cost of one retained block, including its framing.
 * @returns retained ends and omitted UTF-8 text bytes and whole images.
 */
export function retainContent(
  content: readonly RetainableBlock[],
  budget: number,
  price: (block: RetainableBlock) => number,
): RetainedContent {
  const head: RetainableBlock[] = []
  const tail: RetainableBlock[] = []
  let first = 0
  let last = content.length - 1
  let headCharacters = 0
  let remaining = Math.ceil(budget / 2)
  while (first <= last) {
    const block = content[first] as RetainableBlock
    const cost = price(block)
    if (cost <= remaining) {
      head.push(block)
      remaining -= cost
      first++
      continue
    }
    if (block.type === 'text') {
      const text = fitText(block.text, remaining, false, price)
      headCharacters = text.length
      if (text.length > 0) head.push({ type: 'text', text })
    }
    break
  }
  remaining = Math.floor(budget / 2)
  while (last >= first) {
    const original = content[last] as RetainableBlock
    const block = last === first && original.type === 'text'
      ? { type: 'text' as const, text: original.text.slice(headCharacters) }
      : original
    const cost = price(block)
    if (cost <= remaining) {
      tail.push(block)
      remaining -= cost
      last--
      continue
    }
    if (block.type === 'text') {
      const text = fitText(block.text, remaining, true, price)
      if (text.length > 0) tail.push({ type: 'text', text })
    }
    break
  }
  tail.reverse()
  const bytes = (blocks: readonly RetainableBlock[]): number => blocks.reduce(
    (total, block) => total + (block.type === 'text' ? Buffer.byteLength(block.text, 'utf8') : 0), 0)
  const images = (blocks: readonly RetainableBlock[]): number => blocks.filter(block => block.type === 'image').length
  return {
    head,
    tail,
    omittedBytes: bytes(content) - bytes(head) - bytes(tail),
    omittedImages: images(content) - images(head) - images(tail),
  }
}
