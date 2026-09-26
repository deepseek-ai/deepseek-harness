/**
 * The markdown renderer's two mdast grammars, one per rendering arm. Each
 * arm is internally consistent — the incremental tail parses, the one-shot
 * parses, and the plain-text projection of a given grammar always agree on
 * where blocks start and end — and the settled grammar is the streaming one
 * plus the math extensions, so the arms differ only where TeX delimiters
 * begin a math construct (a `$$` block is a paragraph while streaming and a
 * math block once settled, by design).
 */

import type { Root } from 'mdast'
import { recoverLocalImages } from './local-image-syntax.ts'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { mathFromMarkdown } from 'mdast-util-math'
import { gfm } from 'micromark-extension-gfm'
import { math } from 'micromark-extension-math'
import { cjkFriendlyStrong } from './cjkFriendlyStrong.ts'
import { mathCompatibility } from './mathCompatibility.ts'

/**
 * Parse GFM markdown (the streaming arm's grammar: no math, so incomplete
 * TeX never flashes KaTeX errors mid-stream).
 * @param text - Markdown source.
 * @returns The mdast root.
 */
export function parseGfm(text: string): Root {
  return recoverLocalImages(fromMarkdown(text, {
    extensions: [gfm(), cjkFriendlyStrong()],
    mdastExtensions: [gfmFromMarkdown()],
  }), text)
}

/**
 * Parse GFM markdown plus TeX math with the compatibility delimiters
 * (the settled arm's grammar).
 * @param text - Markdown source.
 * @returns The mdast root.
 */
export function parseGfmWithMath(text: string): Root {
  return recoverLocalImages(fromMarkdown(text, {
    extensions: [gfm(), cjkFriendlyStrong(), mathCompatibility(), math()],
    mdastExtensions: [gfmFromMarkdown(), mathFromMarkdown()],
  }), text)
}
