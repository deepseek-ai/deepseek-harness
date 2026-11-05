/** Feature client styles color through ui-theme aliases, never static palette steps or literal colors. */
import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { packageFiles, parseRules } from './stylesheet-scan.ts'

/**
 * Files whose colors are owned artwork or run before ui-theme loads, keyed by
 * repo-relative suffix.
 */
const EXEMPT_FILES: Record<string, string> = {
  'packages/client/ui-primitives/src/FileTypeIcon.module.css': 'file-type artwork palette',
  'packages/client/ui-primitives/src/FileTypeIcon.tsx': 'file-type artwork palette',
  'packages/client/ui-primitives/src/ansi.ts': 'ANSI SGR palette mapping',
  'packages/client/web/src/boot-page.module.css': 'boot page paints before ui-theme loads',
  'packages/client/web/src/base.css': 'shell fallbacks before ui-theme loads',
}

/** Alpha masks and box-shadow ink are geometry, not themed surface or label colors. */
const EXEMPT_PROPERTIES = /^(-webkit-)?mask(-image)?$|^box-shadow$/

/** Hex, color-function, and `white`/`black` literals; other CSS named colors are outside this check. */
const LITERAL_COLOR = new RegExp([
  String.raw`#[0-9a-f]{3,8}\b`,
  String.raw`\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|light-dark)\([^)]*\)`,
  String.raw`(?<![\w-])(white|black)(?![\w-])`,
].join('|'), 'gi')

/** Whether a matched literal has zero alpha, so it paints nothing in any palette. */
function transparentLiteral(literal: string): boolean {
  return /\/\s*0(\.0*)?%?\s*\)$|^(rgba|hsla)\(([^,]*,){3}\s*0(\.0*)?%?\s*\)$/i.test(literal)
}

/** Whether a file is listed in {@link EXEMPT_FILES}. */
function exempt(file: string): boolean {
  return Object.keys(EXEMPT_FILES).some(suffix => file.endsWith(suffix))
}

/**
 * Color violations in one stylesheet.
 * @param css - stylesheet text.
 * @returns `selector { property: value }` descriptions of each violating declaration.
 */
function colorViolations(css: string): string[] {
  return parseRules(css).flatMap(rule => rule.declarations
    .filter(([property, value]) => !EXEMPT_PROPERTIES.test(property) && (
      value.includes('--dsw-static-')
      || [...value.matchAll(LITERAL_COLOR)].some(([literal = '']) => !transparentLiteral(literal))
    ))
    .map(([property, value]) => `${rule.selectors.join(', ')} { ${property}: ${value} }`))
}

/** Stylesheets, scripts and manifests under packages/, collected in one directory walk shared by every test. */
const scanned = packageFiles(name => name === 'package.json' || name.endsWith('.css') || /\.tsx?$/.test(name))
const stylesheets = scanned.filter(file => file.endsWith('.css'))
const scripts = scanned.filter(file => /\.tsx?$/.test(file))

/** Package roots outside packages/client whose manifest declares `dsh.client`. */
const roots = scanned.filter(file => file.endsWith('/package.json')).flatMap((file) => {
  const manifest = JSON.parse(readFileSync(file, 'utf8')) as { dsh?: { client?: object } }
  return manifest.dsh?.client === undefined ? [] : [file.slice(0, -'package.json'.length)]
})

/** Whether a file is feature source covered by the checks: Client package `src/`, not ui-theme sheets or exemptions. */
function featureSource(file: string): boolean {
  return (file.includes('/packages/client/') || roots.some(root => file.startsWith(root)))
    && file.includes('/src/')
    && !file.includes('/packages/client/ui-theme/src/styles/')
    && !exempt(file)
}

it('rejects static palette steps and literal colors outside box shadows, masks and alpha-0 literals', () => {
  expect(colorViolations(`
    .a { color: var(--dsw-static-blue-500); }
    .b { background: #2C2C2E; }
    .c { border-color: rgb(255 255 255 / 0.55); }
    .d { --local: color-mix(in srgb, var(--dsw-static-neutral-00) 5%, transparent); }
    .e { color: rgb(0, 0, 0); }
    .f { fill: white; }
    .g { color: oklch(70% 0.1 250); }
  `)).toEqual([
    '.a { color: var(--dsw-static-blue-500) }',
    '.b { background: #2C2C2E }',
    '.c { border-color: rgb(255 255 255 / 0.55) }',
    '.d { --local: color-mix(in srgb, var(--dsw-static-neutral-00) 5%, transparent) }',
    '.e { color: rgb(0, 0, 0) }',
    '.f { fill: white }',
    '.g { color: oklch(70% 0.1 250) }',
  ])
  expect(colorViolations(`
    .a { color: var(--dsw-alias-label-primary); }
    .b { box-shadow: 0 2px 6px rgba(0, 0, 0, 0.12); }
    .c { mask-image: linear-gradient(#000, transparent); }
    .d { border-left: 3px solid rgb(255 255 255 / 0); }
    .e { border-color: rgba(0, 0, 0, 0); transition: var(--white-space, none); }
  `)).toEqual([])
})

it('keeps feature stylesheets on alias tokens', () => {
  const files = stylesheets.filter(featureSource)
  expect(files.length).toBeGreaterThan(0)
  const failures = files.flatMap(file => colorViolations(readFileSync(file, 'utf8')).map(violation => `${file}: ${violation}`))
  expect(failures).toEqual([])
})

it('keeps static palette steps out of feature scripts', () => {
  const files = scripts.filter(file => !file.endsWith('.d.ts') && featureSource(file))
  expect(files.length).toBeGreaterThan(0)
  expect(files.filter(file => readFileSync(file, 'utf8').includes('--dsw-static-'))).toEqual([])
})

it('names an existing file for every exemption', () => {
  for (const suffix of Object.keys(EXEMPT_FILES)) expect(scanned.some(file => file.endsWith(suffix)), suffix).toBe(true)
})
