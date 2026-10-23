/** Checks CSS layout declarations that jsdom cannot measure. */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const stylesheet = readFileSync(
  fileURLToPath(new URL('../src/client/QuestionComposer.module.css', import.meta.url)),
  'utf8',
).replace(/\/\*[\s\S]*?\*\//g, ' ')

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function split(body: string | undefined): string[] {
  return (body ?? '').split(';').map(part => part.trim()).filter(Boolean)
}

function declarations(selector: string): string[] {
  const rule = new RegExp(`(?:^|\\})\\s*${escape(selector)}\\s*\\{([^{}]*)\\}`).exec(stylesheet)
  if (rule === null) throw new Error(`QuestionComposer.module.css has no \`${selector}\` rule`)
  return split(rule[1])
}

function keyframes(name: string): string[] {
  const rule = new RegExp(`@keyframes ${escape(name)}\\s*\\{\\s*from, to\\s*\\{([^{}]*)\\}`).exec(stylesheet)
  if (rule === null) throw new Error(`QuestionComposer.module.css has no \`${name}\` keyframes`)
  return split(rule[1])
}

describe('QuestionComposer long-copy layout', () => {
  it('reads question overflow against three lines and keeps two once it overflows', () => {
    expect(declarations('.questionTitle')).toEqual(expect.arrayContaining(['flex-shrink: 0', 'timeline-scope: --question-copy']))
    expect(declarations('.titlePreview')).toEqual(expect.arrayContaining([
      'max-height: calc(3lh + 2px)',
      'margin: 0 0 -2px',
      'padding-bottom: 2px',
      'overflow: hidden',
      'scroll-timeline: --question-copy block',
      'animation-name: question-clipped',
      'animation-fill-mode: both',
      'animation-timeline: --question-copy',
    ]))
    expect(keyframes('question-clipped')).toEqual(expect.arrayContaining([
      'margin-bottom: calc(-1lh - 2px)',
      'clip-path: inset(0 0 calc(1lh + 2px) 0)',
      'mask-size: 100% 1lh, 100% 1lh',
      'mask-position: 0 0, 0 1lh',
    ]))
    expect(declarations('.questionToggle')).toEqual(expect.arrayContaining([
      'animation-name: copy-toggle-shown',
      'animation-timeline: --question-copy',
    ]))
  })

  it('reads description overflow against two lines and keeps one once it overflows', () => {
    expect(declarations('.optionRow')).toContain('timeline-scope: --description-copy')
    expect(declarations('.description')).toEqual(expect.arrayContaining([
      'display: block',
      'width: max-content',
      'max-width: 100%',
      'max-height: calc(2lh + 2px)',
      'margin-bottom: -2px',
      'padding-bottom: 2px',
      'overflow: hidden',
      'font-size: 13px',
      'line-height: 20px',
      'scroll-timeline: --description-copy block',
      'animation-name: description-clipped',
      'animation-fill-mode: both',
      'animation-timeline: --description-copy',
    ]))
    expect(keyframes('description-clipped')).toEqual(expect.arrayContaining([
      'margin-bottom: calc(-1lh - 2px)',
      'clip-path: inset(0 0 calc(1lh + 2px) 0)',
      'mask-size: 100% 1lh',
    ]))
    expect(declarations('.descriptionToggle')).toEqual(expect.arrayContaining([
      'animation-name: copy-toggle-shown',
      'animation-timeline: --description-copy',
    ]))
  })

  it('shows a toggle only through the overflow timeline or an expansion', () => {
    expect(declarations('.copyToggle')).toContain('visibility: hidden')
    expect(keyframes('copy-toggle-shown')).toEqual(['visibility: visible'])
    expect(declarations('.questionTitle[data-expanded] .titlePreview,\n.optionRow[data-expanded] .description'))
      .toEqual(['max-height: none', 'animation: none'])
    expect(declarations('.questionTitle[data-expanded] .copyToggle,\n.optionRow[data-expanded] .copyToggle'))
      .toEqual(['visibility: visible', 'animation: none'])
  })

  it('names timelines through longhands that the bundled CSS keeps apart', () => {
    // lightningcss merges `animation` with `animation-timeline` into a shorthand browsers reject.
    const timed = [...stylesheet.matchAll(/\{([^{}]*animation-timeline[^{}]*)\}/g)].map(match => match[1] ?? '')
    expect(timed).toHaveLength(4)
    for (const body of timed) expect(split(body).some(part => part.startsWith('animation:'))).toBe(false)
  })

  it('shows all copy where scroll timelines are unsupported', () => {
    const fallback = /@supports not \(animation-timeline: scroll\(\)\)\s*\{([\s\S]*?)\n\}/.exec(stylesheet)?.[1] ?? ''
    expect(fallback).toMatch(/\.titlePreview,\s*\.description\s*\{\s*max-height: none;\s*animation: none;\s*\}/)
    expect(fallback).toMatch(/\.copyToggle\s*\{\s*display: none;\s*\}/)
  })

  it('keeps the question and choices in the card scrollport', () => {
    expect(declarations('.body')).toEqual(expect.arrayContaining([
      'min-height: 0',
      'overflow-y: auto',
    ]))
    expect(declarations('.questionTitle')).toContain('flex-shrink: 0')
  })
})
