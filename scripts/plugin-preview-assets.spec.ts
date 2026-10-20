/** Plugin feature previews are one fixed-canvas SVG per required UI language, beside their detail document. */
import { globSync, readFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished } from 'vitest'

const root = `${import.meta.dirname}/..`
const svgPaths = globSync('packages/*/*/docs/*.svg', { cwd: root }).sort()
/** Combined size of one language pair, as the standalone bundle and Host routes both serve the files individually. */
const MAX_PAIR_BYTES = 1024 * 1024

it('keeps every preview a self-contained 640×300 SVG with English and Chinese variants', () => {
  // Guard against a narrowed corpus: each preview moved into a bundle's docs directory stays checked.
  expect(svgPaths.length).toBeGreaterThan(0)
  const browser = new JSDOM('')
  onTestFinished(() => { browser.window.close() })
  const parser = new browser.window.DOMParser()
  const pairs = new Map<string, { en?: string; zh?: string }>()
  for (const path of svgPaths) {
    const name = basename(path, '.svg')
    const chinese = name.endsWith('.zh')
    const stem = join(dirname(path), chinese ? name.slice(0, -3) : name)
    const pair = pairs.get(stem) ?? {}
    if (chinese) pair.zh = path
    else pair.en = path
    pairs.set(stem, pair)
  }
  for (const [stem, pair] of pairs) {
    expect(pair, stem).toEqual({ en: `${stem}.svg`, zh: `${stem}.zh.svg` })
  }
  for (const [, pair] of pairs) {
    const sources: string[] = []
    let bytes = 0
    for (const path of [pair.en, pair.zh]) {
      if (path === undefined) throw new Error('Preview pair is incomplete')
      const svg = readFileSync(join(root, path), 'utf8')
      sources.push(svg)
      bytes += Buffer.byteLength(svg)
      const document = parser.parseFromString(svg, 'image/svg+xml')
      expect(document.querySelector('parsererror'), path).toBeNull()
      expect(document.documentElement.namespaceURI, path).toBe('http://www.w3.org/2000/svg')
      expect(document.documentElement.localName, path).toBe('svg')
      expect(document.documentElement.getAttribute('width'), path).toBe('640')
      expect(document.documentElement.getAttribute('height'), path).toBe('300')
      expect(document.documentElement.getAttribute('viewBox'), path).toBe('0 0 640 300')
      expect(document.querySelector('path, rect, circle, ellipse, line, polyline, polygon'), path).not.toBeNull()
      expect(document.querySelector('script, style, foreignObject, text, animate, animateTransform, animateMotion, set'), path).toBeNull()
      const ids = new Set([...document.querySelectorAll('[id]')].map(element => element.id))
      for (const element of [document.documentElement, ...document.querySelectorAll('*')]) {
        for (const attribute of element.attributes) {
          expect(attribute.name, path).not.toMatch(/^on/iu)
          const references = [...attribute.value.matchAll(/url\(([^)]+)\)/gu)].map(match => (match[1] ?? '').replace(/['"]/gu, '').trim())
          if (attribute.localName === 'href') references.push(attribute.value)
          for (const reference of references) {
            if (element.localName === 'image' && attribute.localName === 'href'
              && /^data:image\/(?:png|jpeg|webp);base64,[A-Za-z\d+/]+=*$/u.test(reference)) continue
            expect(reference.startsWith('#') && ids.has(reference.slice(1)), `${path}: ${reference}`).toBe(true)
          }
        }
      }
    }
    expect(bytes, pair.en).toBeLessThanOrEqual(MAX_PAIR_BYTES)
    // The Chinese variant carries translated content; identical files would mean a forgotten translation.
    expect(sources[0], pair.en).not.toBe(sources[1])
    expect(extname(pair.en ?? ''), String(pair.en)).toBe('.svg')
  }
})
