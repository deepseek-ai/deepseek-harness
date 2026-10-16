/** Built-in illustrations have one fixed-canvas SVG per required UI language. */
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { JSDOM } from 'jsdom'
import ts from 'typescript'
import { expect, it, onTestFinished } from 'vitest'
import { OPTIONAL_BUNDLES } from '../packages/boot/app-boot/src/profile.ts'

const pagePath = resolve(import.meta.dirname, '../packages/client/ui-plugin-manager/src/client/PluginManagerPage.tsx')

it('keeps every registered preview a single self-contained 640×300 SVG with English and Chinese variants', () => {
  const page = ts.createSourceFile(pagePath, readFileSync(pagePath, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const imports = new Map<string, string>()
  for (const statement of page.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier) && statement.importClause?.name) {
      imports.set(statement.importClause.name.text, statement.moduleSpecifier.text)
    }
  }
  const declaration = page.statements.filter(ts.isVariableStatement).flatMap(statement => [...statement.declarationList.declarations])
    .find(item => ts.isIdentifier(item.name) && item.name.text === 'BUNDLE_PREVIEWS')
  const initializer = declaration?.initializer
  if (initializer === undefined || !ts.isNewExpression(initializer)) throw new Error('Built-in preview map is missing')
  const entries = initializer.arguments?.[0]
  if (entries === undefined || !ts.isArrayLiteralExpression(entries)) throw new Error('Preview map must list its internal entries')
  expect(entries.elements.length).toBeGreaterThan(0)
  const packages = new Set<string>()
  const browser = new JSDOM('')
  onTestFinished(() => { browser.window.close() })
  const parser = new browser.window.DOMParser()
  for (const entry of entries.elements) {
    if (!ts.isArrayLiteralExpression(entry) || entry.elements.length !== 2) throw new Error('One preview pair per bundle is required')
    const [name, pair] = entry.elements
    if (name === undefined || !ts.isStringLiteral(name) || pair === undefined || !ts.isObjectLiteralExpression(pair)) {
      throw new Error('Each built-in entry must name a bundle and its language pair')
    }
    expect(packages.has(name.text), name.text).toBe(false)
    expect(OPTIONAL_BUNDLES).toContain(name.text)
    packages.add(name.text)
    expect(pair.properties.map(property => property.name?.getText(page)).sort(), name.text).toEqual(['en', 'zh'])
    let bytes = 0
    const sources: string[] = []
    for (const property of pair.properties) {
      if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.initializer)) throw new Error('Preview values must be SVG imports')
      const path = imports.get(property.initializer.text)
      expect(path).toMatch(/^\.\/assets\/[^/]+-preview(?:\.zh)?\.svg$/u)
      if (path === undefined) throw new Error('Preview import is missing')
      expect(path.endsWith('.zh.svg')).toBe(property.name.getText(page) === 'zh')
      const svg = readFileSync(resolve(dirname(pagePath), path), 'utf8')
      bytes += Buffer.byteLength(svg)
      sources.push(svg)
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
            expect(reference.startsWith('#') && ids.has(reference.slice(1)), path).toBe(true)
          }
        }
      }
    }
    expect(bytes, name.text).toBeLessThanOrEqual(1024 * 1024)
    expect(sources[0], name.text).not.toBe(sources[1])
  }
})
