/**
 * Gate for the invariant `FALLBACK_LOCALE` rests on: every shipped dictionary
 * declares the same keys in every shipped language; translations also
 * preserve the English placeholders, command examples, and API field names.
 *
 * The locale runtime resolves a key through the active locale, then through
 * the single fallback locale (`en`), then surfaces the key itself. With
 * symmetric dictionaries that middle step always resolves, so one constant can
 * serve as both the opening locale and the dictionary fallback. A key added to
 * only one side breaks that: a reader of the other language sees a bare key
 * such as `list.aria` instead of text. This gate fails on the asymmetry rather
 * than waiting for the bare key to reach a UI.
 *
 * Discovery is deliberately broad, because a gate that silently narrows is
 * worse than no gate. It sweeps every workspace package (not just
 * `packages/client`), reads dictionaries wherever they are declared —
 * `locales.ts`, a `locales/` directory, or inline in the plugin body — and
 * pairs `zh`/`en` across sibling files as well as within one module. A `zh`
 * dictionary whose `en` counterpart cannot be found anywhere is an error, not
 * a skip.
 */

import type { Dirent } from 'node:fs'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

import { SHIPPED_LOCALE_IDS, localeTokens, hasInvisibleLocaleCharacters, type ShippedLocaleId } from './shipped-locales.ts'

const root = fileURLToPath(new URL('..', import.meta.url))

/** Repo-relative path with `/` separators, so messages and suffix tests match on every OS. */
function relative(file: string): string {
  return file.slice(root.length).replaceAll('\\', '/')
}

/** Every TypeScript source file under each workspace package's `src`, excluding declarations. */
function sourceFiles(): string[] {
  const files: string[] = []
  const packagesRoot = resolve(root, 'packages')
  for (const group of directories(packagesRoot)) {
    for (const pkg of directories(resolve(packagesRoot, group))) {
      walk(resolve(packagesRoot, group, pkg, 'src'), files)
    }
  }
  return files.sort()
}

/** Immediate subdirectory names, or none when the path is not a directory. */
function directories(dir: string): string[] {
  return readEntries(dir).filter(entry => entry.isDirectory()).map(entry => entry.name)
}

/**
 * Directory entries, treating only a genuinely absent directory as empty.
 * Any other failure (`EACCES`, I/O) rethrows: silently reading it as "absent"
 * would narrow the sweep and let the gate pass while checking less.
 * @param dir - absolute directory path.
 * @returns entries, or none when the directory does not exist.
 */
function readEntries(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

function walk(dir: string, out: string[]): void {
  for (const entry of readEntries(dir)) {
    const full = resolve(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if ((/\.tsx?$/u.test(entry.name)) && !entry.name.endsWith('.d.ts')) out.push(full)
  }
}

/** One discovered dictionary: which file and export name declared it. */
interface Dictionary {
  /** Repo-relative declaring file. */
  file: string
  /** Export name, or the registration site for an inline literal. */
  name: string
  /** Declared keys, sorted. */
  keys: string[]
  /** Literal templates used to compare named placeholders. */
  templates: Readonly<Record<string, string>>
}

/**
 * Keys of every top-level `export const <name> = { ... }` object literal whose
 * name identifies a locale dictionary, plus inline `register(ns, locale, {...})`
 * literals. Read from the AST so the gate never executes package code.
 * @param file - absolute path of a candidate module.
 * @returns discovered dictionaries, keyed by locale-bearing name.
 */
function dictionariesIn(file: string): Dictionary[] {
  const text = readFileSync(file, 'utf8')
  // Cheap pre-filter: parsing every package source is wasteful. The pattern
  // must admit every shape `localeOf` accepts, or a file would be skipped
  // before parsing — the silent narrowing this gate exists to prevent. A bare
  // `\b(zh|en)\b` misses `zhSettings`/`accessZh`, because `\b` does not hold
  // between `h` and an uppercase letter.
  if (!/\b(zh|en|ja|es|fr|de|ru|pt)\b|\b(zh|en|ja|es|fr|de|ru|pt)[A-Z]|(Zh|En|Ja|Es|Fr|De|Ru|Pt)\b/.test(text)) return []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
  const found: Dictionary[] = []
  const rel = relative(file)

  // Module-scope variable declarations, keyed by name. A 3-arg
  // `register(NS, 'zh'|'en', dict)` whose third argument is an identifier —
  // e.g. a local dictionary variable rather than an inline literal — resolves
  // through here so the gate still verifies its symmetry.
  const moduleConsts = new Map<string, ts.Expression>()
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer !== undefined) {
        moduleConsts.set(decl.name.text, decl.initializer)
      }
    }
  }

  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if (statement.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) !== true) continue
    for (const decl of statement.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name)) continue
      const literal = unwrap(decl.initializer)
      if (literal === undefined || !ts.isObjectLiteralExpression(literal)) continue
      if (localeOf(decl.name.text) === undefined) continue
      found.push({ file: rel, name: decl.name.text, keys: keysOf(literal), templates: templatesOf(literal) })
    }
  }

  // A 3-arg `register(ns, 'zh'|'en', dict)` call whose dictionary argument we
  // cannot turn into an object literal. We refuse instead of skipping: a
  // registration we cannot measure is exactly the silent narrowing this gate
  // exists to catch.
  const refuse = (ns: string, tag: string, why: string): never => {
    throw new Error(`cannot verify register('${ns}', '${tag}', ...) in ${rel}: ${why}`)
  }

  // Inline registrations, two shapes. A `[['zh', {...}], ['en', {...}]]` pair
  // handed to a registration loop keys off the enclosing array; separate
  // `register(NS, 'zh', {...})` / `register(NS, 'en', {...})` calls key off the
  // namespace argument, so the two calls pair with each other.
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const callee = node.expression
      const name = ts.isPropertyAccessExpression(callee)
        ? callee.name.text
        : ts.isIdentifier(callee) && callee.text === 'register' ? 'register' : undefined
      if (name === 'register' && node.arguments.length >= 3) {
        const [ns, tag, dict] = node.arguments
        if (ns === undefined || tag === undefined || !ts.isStringLiteral(tag)) return
        if (!SHIPPED_LOCALE_IDS.some(id => id === tag.text)) return
        const raw = unwrap(dict)
        const literal = raw !== undefined && ts.isIdentifier(raw)
          ? (() => {
            const resolved = moduleConsts.get(raw.text)
            return resolved === undefined ? undefined : unwrap(resolved)
          })()
          : raw
        const why = raw !== undefined && ts.isIdentifier(raw)
          ? `third argument ${raw.text} does not resolve to an inline or module-scope object literal`
          : 'third argument is neither an object literal nor a resolvable dictionary variable'
        if (literal === undefined || !ts.isObjectLiteralExpression(literal)) {
          // The dictionary argument must resolve to an object literal; the
          // gate refuses rather than skips, so the symmetry it verifies never
          // silently narrows.
          refuse(ns.getText(source), tag.text, why)
        }
        const dictionary: ts.ObjectLiteralExpression = literal as ts.ObjectLiteralExpression
        // The namespace expression's source text identifies the pair, so the
        // zh and en calls for one namespace meet and calls for different
        // namespaces stay apart.
        found.push({ file: rel, name: `${tag.text}@register:${ns.getText(source)}`, keys: keysOf(dictionary), templates: templatesOf(dictionary) })
      }
    }
    if (ts.isArrayLiteralExpression(node) && node.elements.length >= 2) {
      const site = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      for (const element of node.elements) {
        if (!ts.isArrayLiteralExpression(element) || element.elements.length !== 2) continue
        const [tag, dict] = element.elements
        const literal = unwrap(dict)
        if (tag === undefined || !ts.isStringLiteral(tag)) continue
        if (literal === undefined || !ts.isObjectLiteralExpression(literal)) continue
        if (!SHIPPED_LOCALE_IDS.some(id => id === tag.text)) continue
        found.push({ file: rel, name: `${tag.text}@inline:${site}`, keys: keysOf(literal), templates: templatesOf(literal) })
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return found
}

/** Literal templates; shared spread dictionaries are checked at their own declaration. */
function templatesOf(literal: ts.ObjectLiteralExpression): Readonly<Record<string, string>> {
  const templates: Record<string, string> = {}
  for (const property of literal.properties) {
    if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) continue
    if (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) {
      templates[property.name.text] = property.initializer.text
    }
  }
  return templates
}

/** Declared property names of an object literal, sorted. */
function keysOf(literal: ts.ObjectLiteralExpression): string[] {
  const keys: string[] = []
  for (const prop of literal.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    if (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name)) keys.push(prop.name.text)
  }
  return keys.sort()
}

/** Look through `satisfies`/`as`/parenthesized wrappers to the literal. */
function unwrap(node: ts.Expression | undefined): ts.Expression | undefined {
  let current = node
  while (
    current !== undefined
    && (ts.isSatisfiesExpression(current) || ts.isAsExpression(current) || ts.isParenthesizedExpression(current))
  ) {
    current = current.expression
  }
  return current
}

/**
 * The locale a dictionary name declares, and the namespace-ish remainder that
 * identifies which pair it belongs to. `zh`/`en`, `zhSettings`/`enSettings`,
 * and `settingsZh`/`settingsEn` are the shapes this repo uses. A name-prefix
 * shape requires an uppercase ASCII letter at the third position (`[A-Z]`),
 * matching the admission of the cheap pre-filter, so `zh2Foo`/`zh_probe`
 * cannot be treated as dictionaries in one place and skipped in another.
 * @param name - export name or synthetic inline name.
 * @returns locale plus pair key, or undefined when the name names no locale.
 */
function localeOf(name: string): { locale: ShippedLocaleId; pair: string } | undefined {
  for (const locale of SHIPPED_LOCALE_IDS) {
    const other = locale[0]!.toUpperCase() + locale.slice(1)
    if (name === locale) return { locale, pair: '' }
    // Synthetic names for inline shapes carry their own pair key after the
    // first ':' (the enclosing array's line, or the namespace expression).
    if (name.startsWith(`${locale}@`)) return { locale, pair: name.slice(name.indexOf(':')) }
    if (name.startsWith(locale) && name.length > 2 && /[A-Z]/.test(name[2] ?? '')) {
      return { locale, pair: name.slice(2) }
    }
    if (name.endsWith(other)) return { locale, pair: name.slice(0, -2) }
  }
  return undefined
}

/**
 * Check that each object-form registration supplies every shipped-language dictionary.
 * @param file - absolute source path.
 * @returns registration sites missing a shipped language, or using an unresolved local identifier.
 */
function registrationProblems(file: string): string[] {
  const text = readFileSync(file, 'utf8')
  if (!text.includes('.register(')) return []
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ESNext, true)
  const locals = new Map<string, ts.Expression>()
  const imported = new Set<string>()
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined) {
      locals.set(node.name.text, node.initializer)
    }
    if (ts.isImportSpecifier(node)) imported.add(node.name.text)
    ts.forEachChild(node, collect)
  }
  collect(source)
  const problems: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'register' && node.arguments.length === 2) {
      const argument = unwrap(node.arguments[1])
      const dicts = argument !== undefined && ts.isIdentifier(argument)
        ? unwrap(locals.get(argument.text)) : argument
      if (dicts !== undefined && ts.isObjectLiteralExpression(dicts)) {
        const entries = new Map<string, ts.Expression>()
        for (const prop of dicts.properties) {
          if (ts.isShorthandPropertyAssignment(prop)) entries.set(prop.name.text, prop.name)
          else if (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))) {
            entries.set(prop.name.text, prop.initializer)
          }
        }
        if (entries.has('zh') && entries.has('en')) {
          const site = `${relative(file)}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`
          for (const language of SHIPPED_LOCALE_IDS) {
            const dictionary = entries.get(language)
            if (dictionary === undefined) problems.push(`${site}: registration has no ${language} dictionary`)
            else if (ts.isIdentifier(dictionary) && !imported.has(dictionary.text) && !locals.has(dictionary.text)) {
              problems.push(`${site}: ${language} dictionary ${dictionary.text} is not imported or declared`)
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return problems
}

describe('shipped locale dictionaries', () => {
  it('registers every shipped language alongside every object-form bilingual dictionary', () => {
    expect(sourceFiles().flatMap(registrationProblems)).toEqual([])
  })

  it('keeps bilingual keys aligned and shipped-language keys and placeholders complete', () => {
    const files = sourceFiles()
    // Guard the discovery itself: an empty or narrowed sweep would pass every
    // assertion below while checking nothing.
    expect(files.length).toBeGreaterThan(500)

    // Pair within a file first; a dictionary whose counterpart is not in the
    // same module then pairs with a sibling in the same directory. Both shapes
    // ship here: `locales/settings.ts` exports zh+en together, while
    // `locales/zh.ts` + `locales/en.ts` split the common pair across files.
    const perFile = new Map<string, Dictionary[]>()
    for (const file of files) {
      const dicts = dictionariesIn(file)
      if (dicts.length > 0) {
        expect(hasInvisibleLocaleCharacters(readFileSync(file, 'utf8')), relative(file)).toBe(false)
        for (const dictionary of dicts) {
          for (const text of Object.values(dictionary.templates)) expect(hasInvisibleLocaleCharacters(text), relative(file)).toBe(false)
        }
        perFile.set(relative(file), dicts)
      }
    }

    const groups = new Map<string, Map<ShippedLocaleId, Dictionary>>()
    const place = (key: string, locale: ShippedLocaleId, dict: Dictionary): void => {
      const slot = groups.get(key) ?? new Map<ShippedLocaleId, Dictionary>()
      if (slot.has(locale)) {
        throw new Error(`two ${locale} dictionaries claim pair ${key}: ${slot.get(locale)?.file} and ${dict.file}`)
      }
      slot.set(locale, dict)
      groups.set(key, slot)
    }

    for (const [rel, dicts] of perFile) {
      for (const dict of dicts) {
        const parsed = localeOf(dict.name)
        if (parsed === undefined) continue
        const sameFileCounterpart = dicts.some((other) => {
          const otherParsed = localeOf(other.name)
          return otherParsed !== undefined
            && otherParsed.pair === parsed.pair
            && otherParsed.locale !== parsed.locale
        })
        // Same-file pairs key by file so two pairs in one directory stay
        // distinct; split pairs key by directory so siblings meet.
        const key = sameFileCounterpart ? `${rel}::${parsed.pair}` : `${dirname(rel)}::${parsed.pair}`
        place(key, parsed.locale, dict)
      }
    }

    const problems: string[] = []
    let comparedPairs = 0
    for (const [key, slot] of [...groups].sort()) {
      const zh = slot.get('zh')
      const en = slot.get('en')
      if (zh === undefined || en === undefined) {
        const present = zh ?? en
        problems.push(`${present?.file} declares ${present?.name} with no counterpart for pair ${key}`)
        continue
      }
      comparedPairs++
      const zhOnly = zh.keys.filter(k => !en.keys.includes(k))
      const enOnly = en.keys.filter(k => !zh.keys.includes(k))
      if (zhOnly.length > 0) problems.push(`${zh.file} ${zh.name} has keys absent from ${en.name}: ${zhOnly.join(', ')}`)
      if (enOnly.length > 0) problems.push(`${en.file} ${en.name} has keys absent from ${zh.name}: ${enOnly.join(', ')}`)
      for (const language of SHIPPED_LOCALE_IDS.filter(id => id !== 'en' && id !== 'zh')) {
        const translatedDictionary = slot.get(language)
        if (translatedDictionary === undefined) {
          problems.push(`${key} has no ${language} dictionary`)
        } else {
          const missing = en.keys.filter(k => !translatedDictionary.keys.includes(k))
          const extra = translatedDictionary.keys.filter(k => !en.keys.includes(k))
          if (missing.length > 0 || extra.length > 0) {
            problems.push(`${translatedDictionary.file} ${translatedDictionary.name}: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`)
          }
          for (const [name, text] of Object.entries(en.templates)) {
            const translated = translatedDictionary.templates[name]
            if (translated === undefined) continue
            const placeholders = (value: string): string => localeTokens(value).join(', ')
            if (placeholders(text) !== placeholders(translated)) {
              problems.push(`${translatedDictionary.file} ${translatedDictionary.name}.${name} changes placeholders or literal tokens from ${en.name}`)
            }
          }
        }
      }
    }

    // The shipped dictionary count only grows; a collapse means discovery or
    // pairing broke, which would hide real asymmetry.
    expect(comparedPairs).toBeGreaterThan(25)
    expect(problems).toEqual([])
  })
})
