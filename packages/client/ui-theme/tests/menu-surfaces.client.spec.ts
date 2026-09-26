/** All menu renderers share material ownership, including custom listbox containers. */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { packageStylesheets, parseRules } from './stylesheet-scan.ts'

const packages = fileURLToPath(new URL('../../../', import.meta.url))

function menuViolations(source: string): string[] {
  const ast = ts.createSourceFile('menu.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const failures: string[] = []
  const visit = (node: ts.Node, insideSurface: boolean): void => {
    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined
    const surface = opening?.tagName.getText(ast) === 'MenuSurface'
    if (opening !== undefined) {
      const role = opening.attributes.properties.find(attribute => ts.isJsxAttribute(attribute) && attribute.name.getText(ast) === 'role')
      if (role !== undefined && ts.isJsxAttribute(role) && role.initializer !== undefined
        && ts.isStringLiteral(role.initializer) && ['menu', 'listbox'].includes(role.initializer.text)
        && !surface && !insideSurface) failures.push(role.initializer.text)
    }
    ts.forEachChild(node, (child) => { visit(child, insideSurface || surface) })
  }
  visit(ast, false)
  return failures
}

function sourceFiles(): string[] {
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.isFile() && entry.name.endsWith('.tsx')) files.push(file)
    }
  }
  for (const group of readdirSync(packages, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    for (const pkg of readdirSync(join(packages, group.name), { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      const src = join(packages, group.name, pkg.name, 'src')
      if (existsSync(src)) walk(src)
    }
  }
  return files
}

function materialOverrides(css: string, selectors: ReadonlySet<string>): string[] {
  return parseRules(css).flatMap((rule) => {
    const targetsMenu = rule.selectors.some(selector => !selector.includes('::') && [...selector.matchAll(/\.([\w-]+)/g)]
      .some(match => selectors.has(match[1]!)))
    return targetsMenu ? rule.declarations
      .filter(([name]) => ['background', 'background-color', 'backdrop-filter', 'anchor-name'].includes(name))
      .map(([name]) => `${rule.selectors.join(', ')}: ${name}`) : []
  })
}

describe('shared menu material', () => {
  it('rejects custom menu and listbox containers without MenuSurface', () => {
    expect(menuViolations('<div role="menu" />')).toEqual(['menu'])
    expect(menuViolations('<section><div role="listbox" /></section>')).toEqual(['listbox'])
    expect(menuViolations('<MenuSurface role="menu" />')).toEqual([])
    expect(menuViolations('<MenuSurface><div role="listbox" /></MenuSurface>')).toEqual([])
  })

  it('requires shared material outside the schedule-owned menu and clock picker', () => {
    expect(sourceFiles().flatMap(file => menuViolations(readFileSync(file, 'utf8'))
      .map(role => `${relative(packages, file).replaceAll('\\', '/')}: ${role}`))).toEqual([
      'client/ui-schedule/src/client/ClockPicker.tsx: listbox',
      'client/ui-schedule/src/client/TaskMenu.tsx: menu',
    ])
  })

  it('rejects local material overrides, including state rules', () => {
    expect(materialOverrides('.menu { background: white; backdrop-filter: none; }', new Set(['menu'])))
      .toEqual(['.menu: background', '.menu: backdrop-filter'])
    expect(materialOverrides('.menu:hover { background-color: white; }', new Set(['menu'])))
      .toEqual(['.menu:hover: background-color'])
    expect(materialOverrides('.menu { padding: 4px; } .item { background: red; }', new Set(['menu'])))
      .toEqual([])
  })

  it('keeps menu consumer classes from replacing the material', () => {
    const failures: string[] = []
    for (const file of sourceFiles()) {
      if (file.endsWith('MenuSurface.tsx')) continue
      const source = readFileSync(file, 'utf8')
      const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const classes = new Set<string>()
      const visit = (node: ts.Node): void => {
        if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(ast) === 'MenuSurface') {
          const attribute = node.attributes.properties.find(prop => ts.isJsxAttribute(prop) && prop.name.getText(ast) === 'className')
          for (const match of attribute?.getText(ast).matchAll(/css\.([\w]+)/g) ?? []) classes.add(match[1]!)
        }
        ts.forEachChild(node, visit)
      }
      visit(ast)
      if (classes.size === 0) continue
      const sheet = source.match(/import css from ['"](.+\.css)['"]/)?.[1]
      if (sheet === undefined) continue
      const css = readFileSync(resolve(dirname(file), sheet), 'utf8')
      failures.push(...materialOverrides(css, classes).map(failure => `${file}: ${failure}`))
    }
    expect(failures).toEqual([])
  })

  it('keeps menu fill and blur tokens owned by the theme on every platform', () => {
    const failures = packageStylesheets().flatMap(file => parseRules(readFileSync(file, 'utf8'))
      .flatMap(rule => rule.declarations.filter(([name]) =>
        (['--dsw-specific-menu', '--dsw-menu-surface-fill'].includes(name) && !file.endsWith('/ui-theme/src/styles/design-platform.css'))
        || (name === '--dsw-menu-backdrop-filter' && !file.endsWith('/ui-theme/src/styles/gradient-shadow-text.css'))))
      .map(([name]) => `${file}: ${name}`))
    expect(failures).toEqual([])
  })
})
