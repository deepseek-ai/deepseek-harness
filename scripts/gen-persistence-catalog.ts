/**
 * Generate `docs/persistence-catalog.md` from every `SessionEventMap` merge and
 * the owning event-envelope types. This is the durable-record vocabulary, not
 * the live Cordis bus. Event declarations must be unique, explicitly typed,
 * documented, inheritance-free, and free of Cordis-only `@mode` tags; every
 * surface-union member must resolve to one. `--check` verifies the artifact.
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import ts from 'typescript'
import { parseJsDoc, pointer, rawJsDoc, reportViolations } from './jsdoc.ts'
import { githubSlug } from './verify-md-links.ts'

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/persistence-catalog.md'
const OUT_RUNTIME_TYPES = 'packages/core/session/src/known-event-types.ts'

/** The fenced-block info string for generated declaration blocks (skipped by
 * doc-typecheck, since their imported types are not standalone-compilable). */
const FENCE = 'ts persistence-catalog'

/** The package that owns the durable event vocabulary. */
const SESSION_PACKAGE = '@deepseek-ai/dsh-session'

/** The type-only module that plugin declaration merges augment. */
const SESSION_TYPES_MODULE = '@deepseek-ai/dsh-session/types'

/** Event-envelope declarations rendered before the per-event vocabulary. */
const EVENT_ENVELOPE_TYPE_NAMES = [
  'SessionEventType',
  'SurfaceEventType',
  'SurfaceOp',
  'SessionEvent',
] as const

type EventEnvelopeTypeName = typeof EVENT_ENVELOPE_TYPE_NAMES[number]

/** Documentation target, relative to `docs/`, for linked payload types. */
const LINK_MAP: Record<string, string> = {
  ToolCallId: 'subsystems/core.md',
  ContentBlock: 'subsystems/core.md',
  MessageSource: 'subsystems/core.md',
  ScheduleChange: 'subsystems/schedule.md',
  StreamChunk: 'subsystems/llm-streaming.md',
  TokenUsage: 'subsystems/llm-streaming.md',
  TodoItem: 'subsystems/todo.md',
  TurnTrigger: 'subsystems/session.md',
  TurnEndReason: 'subsystems/session.md',
  SessionTitleEventData: 'subsystems/session-title.md',
  SessionTitleLlmRequestEventData: 'subsystems/session-title.md',
  SessionTitleModelProvenance: 'subsystems/session-title.md',
  SessionTitleProviderId: 'subsystems/session-title.md',
  SessionTitleSource: 'subsystems/session-title.md',
  TeamId: 'subsystems/agent-team.md',
  TeamMemberSnapshot: 'subsystems/agent-team.md',
  TeamMessageId: 'subsystems/agent-team.md',
  TeamMessageSnapshot: 'subsystems/agent-team.md',
  TeamTaskSnapshot: 'subsystems/agent-team.md',
}

/** One log event, extracted from a `SessionEventMap` declaration. */
export interface LogEventEntry {
  /** Scoped name, e.g. `turn/start`. */
  name: string
  /** The scope prefix, e.g. `turn` (everything before the first `/`). */
  scope: string
  /** Payload type text (the member's type annotation, whitespace-collapsed). */
  payload: string
  /** Source member declaration and complete JSDoc, dedented from its container. */
  declaration: string
  /** Description prose (the member's JSDoc), one line per paragraph. */
  doc: string
  /** Source pointer `packages/…/file.ts:line` of the declaration. */
  source: string
}

/** A {@link LogEventEntry} plus its surface-eligibility badge. */
export interface AnnotatedLogEventEntry extends LogEventEntry {
  /** Whether the type is a `SurfaceEventType` member (may carry `surfaceOp`). */
  surface: boolean
}

/** One owning event-envelope declaration pasted into the generated catalog. */
export interface EventEnvelopeTypeEntry {
  /** Exported declaration name. */
  name: EventEnvelopeTypeName
  /** Verbatim type declaration, including its complete leading JSDoc. */
  declaration: string
  /** Source pointer `packages/…/file.ts:line` of the declaration. */
  source: string
}

const printer = ts.createPrinter({ removeComments: true })

/**
 * Render a member type on one line through the TypeScript printer, which adds
 * semicolon separators. Drop its trailing semicolon before `}` to match the
 * repository's inline-literal style.
 */
function payloadText(type: ts.TypeNode, sf: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, type, sf)
    .replace(/\s+/g, ' ')
    .replace(/;\s*\}/g, ' }')
    .trim()
}

/**
 * Copy a declaration from its leading JSDoc through its closing token while
 * removing only the indentation imposed by its containing interface/module.
 */
function declarationText(text: string, sf: ts.SourceFile, node: ts.Node): string {
  const raw = rawJsDoc(text, node)
  const nodeStart = node.getStart(sf)
  const start = raw ? text.lastIndexOf(raw, nodeStart) : nodeStart
  const { line } = sf.getLineAndCharacterOfPosition(start)
  const lineStart = sf.getPositionOfLineAndCharacter(line, 0)
  const indent = text.slice(lineStart, start)
  return text.slice(lineStart, node.end)
    .split('\n')
    .map(lineText => lineText.startsWith(indent) ? lineText.slice(indent.length) : lineText)
    .join('\n')
    .trimEnd()
}

/**
 * Every `interface SessionEventMap` declaration in a source file: the owning
 * top-level declaration (in `@deepseek-ai/dsh-session`) and any declaration
 * merge inside a `declare module '@deepseek-ai/dsh-session/types'` block. Both forms
 * declare members of the SAME merged interface, so both are catalogued
 * uniformly. `topLevel` distinguishes the owning form so the caller can verify
 * it actually lives in the owning package — an unrelated local interface that
 * happens to share the name must not be catalogued as the on-disk vocabulary.
 */
function sessionEventMapDecls(sf: ts.SourceFile): { decl: ts.InterfaceDeclaration; topLevel: boolean }[] {
  const decls: { decl: ts.InterfaceDeclaration; topLevel: boolean }[] = []
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === 'SessionEventMap') decls.push({ decl: stmt, topLevel: true })
    if (ts.isModuleDeclaration(stmt) && ts.isStringLiteral(stmt.name) && stmt.name.text === SESSION_TYPES_MODULE
      && stmt.body && ts.isModuleBlock(stmt.body)) {
      for (const inner of stmt.body.statements) {
        if (ts.isInterfaceDeclaration(inner) && inner.name.text === 'SessionEventMap') decls.push({ decl: inner, topLevel: false })
      }
    }
  }
  return decls
}

/**
 * The npm package name owning a `packages/<group>/<pkg>/…` source file, read
 * from that package's manifest — or null when the manifest is missing or
 * unparseable (the caller treats null as "ownership unverifiable").
 */
function packageNameFor(rel: string, scanRoot: string): string | null {
  const dir = rel.split('/').slice(0, 3).join('/')
  try {
    const manifest = JSON.parse(readFileSync(resolve(scanRoot, dir, 'package.json'), 'utf8')) as { name?: string }
    return typeof manifest.name === 'string' ? manifest.name : null
  } catch {
    // Missing or malformed package.json — every real workspace package has one,
    // so this only arises in stripped-down fixture trees; either way ownership
    // cannot be verified and the caller reports the declaration.
    return null
  }
}

/**
 * Collect every `SessionEventMap` merge, rejecting inherited, non-literal,
 * untyped, undocumented, duplicate, or incorrectly owned members in one report.
 */
export function collectLogEvents(scanRoot: string = root): LogEventEntry[] {
  const entries: LogEventEntry[] = []
  const violations: string[] = []
  const seen = new Map<string, string>()
  let owningDecl: string | null = null
  for (const rel of globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot }).map(s => s.split(sep).join('/')).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('SessionEventMap')) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    for (const { decl, topLevel } of sessionEventMapDecls(sf)) {
      const declSrc = pointer(rel, sf, decl)
      if (topLevel) {
        // The top-level form has one home: the single exported declaration in
        // the owning package. Same-named interfaces elsewhere are different
        // types and must not enter the on-disk catalog.
        const pkg = packageNameFor(rel, scanRoot)
        if (pkg !== SESSION_PACKAGE) {
          violations.push(`top-level interface SessionEventMap (${declSrc}) is outside ${SESSION_PACKAGE} (package ${pkg ?? 'unknown'}). Rename the interface, or contribute events via declare module '${SESSION_TYPES_MODULE}'.`)
          continue
        }
        const exported = decl.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
        if (!exported) {
          violations.push(`top-level interface SessionEventMap (${declSrc}) is not exported; the owning vocabulary is the single exported declaration — rename a local helper interface.`)
          continue
        }
        if (owningDecl) {
          violations.push(`top-level interface SessionEventMap (${declSrc}) is already declared at ${owningDecl}; the owning vocabulary has exactly one home.`)
          continue
        }
        owningDecl = declSrc
      }
      if (decl.heritageClauses?.length) {
        violations.push(`SessionEventMap declaration (${declSrc}) uses extends; inherited keys would join keyof SessionEventMap without a catalog row — declare event members directly.`)
      }
      for (const member of decl.members) {
        const src = pointer(rel, sf, member)
        if (!ts.isPropertySignature(member) || !member.type) {
          // A method-form or type-less member still joins `keyof SessionEventMap`,
          // so skipping it silently would be exactly the undocumented-event hole
          // this catalog exists to close.
          const label = (member as { name?: ts.Node }).name?.getText(sf) ?? member.getText(sf).replace(/\s+/g, ' ')
          violations.push(`SessionEventMap member ${label} (${src}) is not a property signature with an explicit payload type; declare every log event as 'scope/name': <payload>.`)
          continue
        }
        if (!ts.isStringLiteral(member.name)) {
          violations.push(`log event at ${src} has a non-literal name; the catalog needs string-literal event names.`)
          continue
        }
        const name = member.name.text
        const where = `log event '${name}' (${src})`
        const prior = seen.get(name)
        if (prior) {
          violations.push(`${where} is already declared at ${prior}; an event type has exactly one declaration.`)
          continue
        }
        seen.set(name, src)
        const payload = payloadText(member.type, sf)
        const { doc, hasMode } = parseJsDoc(rawJsDoc(text, member))
        if (hasMode) {
          violations.push(`${where} carries an @mode tag, but a log event has no dispatch mode (it is not a cordis bus event — it rides the 'session/event' emit). Remove the tag.`)
        }
        if (!doc) {
          violations.push(`${where} has no description prose. Say what the event records and what its payload means — the JSDoc becomes the catalog entry.`)
        }
        const declaration = declarationText(text, sf, member)
        entries.push({ name, scope: name.split('/')[0] ?? name, payload, declaration, doc, source: src })
      }
    }
  }
  reportViolations('gen-persistence-catalog', violations)
  return entries
}

/**
 * Collect the exported declarations that compose the persisted event envelope,
 * preserving their source JSDoc and declaration text.
 */
export function collectEventEnvelopeTypes(scanRoot: string = root): EventEnvelopeTypeEntry[] {
  const found = new Map<EventEnvelopeTypeName, EventEnvelopeTypeEntry>()
  const violations: string[] = []
  const wanted = new Set<string>(EVENT_ENVELOPE_TYPE_NAMES)
  for (const rel of globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot }).map(s => s.split(sep).join('/')).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!EVENT_ENVELOPE_TYPE_NAMES.some(name => text.includes(name))) continue
    if (packageNameFor(rel, scanRoot) !== SESSION_PACKAGE) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    for (const stmt of sf.statements) {
      if (!ts.isTypeAliasDeclaration(stmt) || !wanted.has(stmt.name.text)) continue
      const name = stmt.name.text as EventEnvelopeTypeName
      const src = pointer(rel, sf, stmt)
      const where = `event-envelope type '${name}' (${src})`
      const prior = found.get(name)
      if (prior) {
        violations.push(`${where} is already declared at ${prior.source}; the persisted envelope type has exactly one owner.`)
        continue
      }
      if (!(stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)) {
        violations.push(`${where} is not exported.`)
      }
      const { doc, hasMode } = parseJsDoc(rawJsDoc(text, stmt))
      if (hasMode) violations.push(`${where} carries an @mode tag, but a persisted type has no dispatch mode.`)
      if (!doc) violations.push(`${where} has no description prose. The full JSDoc is part of the generated catalog.`)
      found.set(name, { name, declaration: declarationText(text, sf, stmt), source: src })
    }
  }
  const missing = EVENT_ENVELOPE_TYPE_NAMES.filter(name => !found.has(name))
  if (missing.length > 0) {
    violations.push(`missing event-envelope declaration(s): ${missing.join(', ')}.`)
  }
  reportViolations('gen-persistence-catalog', violations)
  return EVENT_ENVELOPE_TYPE_NAMES.map((name) => {
    const entry = found.get(name)
    if (!entry) throw new Error(`gen-persistence-catalog: missing checked event-envelope declaration '${name}'.`)
    return entry
  })
}

/**
 * Parse the `SurfaceEventType` union — the surface-eligible subset of event
 * types — from source. Hard-errors when the alias is missing, declared more
 * than once, or contains a non-string-literal member: the badge derivation
 * relies on the union being a closed set of literal event names.
 * `scanRoot` defaults to the repo root; tests pass a fixture dir.
 */
export function collectSurfaceEventTypes(scanRoot: string = root): string[] {
  const found: { names: string[]; source: string }[] = []
  for (const rel of globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot }).map(s => s.split(sep).join('/')).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('SurfaceEventType')) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    for (const stmt of sf.statements) {
      if (!ts.isTypeAliasDeclaration(stmt) || stmt.name.text !== 'SurfaceEventType') continue
      const src = pointer(rel, sf, stmt)
      const members = ts.isUnionTypeNode(stmt.type) ? [...stmt.type.types] : [stmt.type]
      const names: string[] = []
      for (const m of members) {
        if (ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal)) names.push(m.literal.text)
        else throw new Error(`gen-persistence-catalog: SurfaceEventType (${src}) has a non-string-literal member; the badge derivation needs a closed literal union.`)
      }
      found.push({ names, source: src })
    }
  }
  const only = found[0]
  if (!only) throw new Error('gen-persistence-catalog: no SurfaceEventType union found under packages/*/*/src.')
  if (found.length > 1) throw new Error(`gen-persistence-catalog: SurfaceEventType is declared more than once (${found.map(f => f.source).join(', ')}); the surface subset has exactly one owner.`)
  return only.names
}

/**
 * Attach the surface/log-only badge to each event. Hard-errors when a
 * `SurfaceEventType` union member names no collected event — a stale union
 * member would otherwise silently badge nothing.
 */
export function annotateSurface(events: LogEventEntry[], surfaceTypes: string[]): AnnotatedLogEventEntry[] {
  const names = new Set(events.map(e => e.name))
  const stale = surfaceTypes.filter(t => !names.has(t))
  if (stale.length > 0) {
    throw new Error(`gen-persistence-catalog: SurfaceEventType member(s) ${stale.map(t => `'${t}'`).join(', ')} name no declared log event (stale union member?).`)
  }
  const surface = new Set(surfaceTypes)
  return events.map(e => ({ ...e, surface: surface.has(e.name) }))
}

/** Render the cross-link "Types:" line for a payload, or '' if none apply. */
function typeLinks(payload: string): string {
  const seen = new Set<string>()
  for (const name of Object.keys(LINK_MAP)) {
    if (new RegExp(`\\b${name}\\b`).test(payload)) seen.add(name)
  }
  if (seen.size === 0) return ''
  const links = [...seen].sort().map(n => `[${n}](${LINK_MAP[n]})`)
  return `Types: ${links.join(' · ')}`
}

/** Render one log event entry. */
function renderEvent(e: AnnotatedLogEventEntry): string[] {
  const heading = `${e.name} — ${e.surface ? 'surface' : 'log-only'}`
  const out = [`<a id="${githubSlug(heading)}"></a>`, '', `#### \`${e.name}\` — ${e.surface ? 'surface' : 'log-only'}`, '']
  out.push('```' + FENCE, e.declaration, '```', '')
  const links = typeLinks(e.payload)
  if (links) out.push(links, '')
  out.push(`Source: [\`${e.source}\`](../${e.source.split(':')[0]})`, '')
  return out
}

/** Render the full catalog (pure, deterministic given the collected inputs). */
export function render(events: AnnotatedLogEventEntry[], envelopeTypes: EventEnvelopeTypeEntry[]): string {
  const lines: string[] = [
    '<!-- Generated by scripts/gen-persistence-catalog.ts — do not edit by hand.',
    '     Run `pnpm run gen-persistence-catalog` to regenerate. -->',
    '',
    '# Session Persistence Event Catalog',
    '',
    'Every event type that can appear in a session\'s durable event log: the complete persisted `SessionEvent` envelope and each member of the merge-extensible `SessionEventMap` — the owning vocabulary in `@deepseek-ai/dsh-session` plus every plugin declaration merge into `@deepseek-ai/dsh-session/types` in this repo — with source JSDoc, full payload declaration, surface badge, and declaration site. It complements [session.md](subsystems/session.md) (surface ordering and the `deriveMessages()` projection), [persistence.md](subsystems/persistence.md) (how the log is made durable), and the generated region of [session.md](subsystems/session.md#cordis-surface) (the live bus wiring — a log event is NOT a cordis event; it reaches listeners via the single `session/event` emit).',
    '',
    'This file is GENERATED from source (`scripts/gen-persistence-catalog.ts`) and verified fresh by `pnpm run verify-persistence-catalog` (part of `doc-sync`) — do not edit it by hand. Declaration blocks retain the source declaration and nested property JSDoc, removing only the indentation imposed by a containing interface/module, and use a `ts persistence-catalog` fence (skipped by doc-typecheck because declarations reference types from their owning modules). Type names in a payload link to the page that documents them. See [the persistence-log-catalog Agent Note](../.agents/notes/archived/process/2026-07-04-persistence-log-catalog.md).',
    '',
    'The envelope declarations below compose each event\'s `type`, monotonic `seq`, epoch-ms `time`, `data`, the optional `ignorable` unknown-type skip marker, and the conditional `surfaceOp`/`sourceEventSeqs` fields. **surface** marks a `SurfaceEventType` member: it produces an LLM message and declares how it joins the surface list. **log-only** marks everything else: a durable, replayable record with no derived-history contribution. Every payload is JSON-serializable (enforced at `Session.append`). Current writers stamp `SESSION_FORMAT_VERSION`; supported historical artifacts reach this current vocabulary through the build-static adjacent migration catalog ([the version lifecycle](subsystems/persistence.md)). Scope: the packages in this repo; a downstream plugin can merge further current-version event types, which are outside this catalog by construction and require an explicit disposition at a later format edge.',
    '',
    '## Event envelope',
    '',
    '```' + FENCE,
    envelopeTypes.map(entry => entry.declaration).join('\n\n'),
    '```',
    '',
    `Sources: ${envelopeTypes.map(entry => `[\`${entry.source}\`](../${entry.source.split(':')[0]})`).join(' · ')}`,
    '',
    '## Events',
    '',
  ]
  const scopes = [...new Set(events.map(e => e.scope))].sort()
  for (const scope of scopes) {
    lines.push(`### \`${scope}/*\``, '')
    for (const e of events.filter(x => x.scope === scope).sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(...renderEvent(e))
    }
  }
  return lines.join('\n')
}

/**
 * Render the runtime known-vocabulary module: every event type the packages in
 * this repo can write, as a generated `ReadonlySet` the read path checks
 * unknown-type refusal against (`SessionEvent.ignorable` contract).
 */
export function renderKnownEventTypes(events: AnnotatedLogEventEntry[]): string {
  const names = [...new Set(events.map(e => e.name))].sort()
  return [
    '/**',
    ' * GENERATED by `scripts/gen-persistence-catalog.ts` — do not edit by hand; run',
    ' * `pnpm run gen-persistence-catalog` to regenerate (verified fresh by',
    ' * `pnpm run verify-persistence-catalog`, part of `doc-sync`).',
    ' * @module @deepseek-ai/dsh-session/known-event-types',
    ' */',
    '',
    '/**',
    ' * Every `SessionEventMap` member declared in this repository — the event',
    ' * vocabulary this build understands. The persistence read path refuses to',
    ' * interpret a log containing a type outside this set unless the event',
    ' * carries the envelope\'s `ignorable` marker (see `SessionEvent.ignorable`',
    ' * in `./types.ts`): such a log was likely written by a newer harness, and',
    ' * silently skipping a required event would reconstruct a wrong session.',
    ' * Downstream (out-of-repo) plugin events are outside this list by',
    ' * construction. The persisted `SessionEvent.ignorable` marker is the',
    ' * compatibility mechanism; event-name registration was rejected because',
    ' * it does not classify omission safety and would make reads',
    ' * composition-dependent. The rationale is in',
    ' * `.agents/notes/implemented/architecture/2026-08-30-retain-ignorable-external-session-events.md`.',
    ' */',
    'export const KNOWN_SESSION_EVENT_TYPES: ReadonlySet<string> = new Set([',
    ...names.map(name => `  '${name}',`),
    '])',
    '',
  ].join('\n')
}

/** One generated artifact: repo-relative target and its freshly-rendered content. */
interface GeneratedArtifact {
  readonly out: string
  readonly content: string
}

/** CLI entry: default writes the artifacts, `--check` fails if a committed copy
 * is stale. Guarded behind an entry-point check so importing this module for
 * tests neither regenerates the committed files nor calls process.exit. */
function main(): void {
  const events = annotateSurface(collectLogEvents(), collectSurfaceEventTypes())
  const artifacts: GeneratedArtifact[] = [
    { out: OUT, content: render(events, collectEventEnvelopeTypes()) },
    { out: OUT_RUNTIME_TYPES, content: renderKnownEventTypes(events) },
  ]
  if (process.argv.includes('--check')) {
    const stale = artifacts.filter((artifact) => {
      let committed: string | null = null
      try {
        committed = readFileSync(resolve(root, artifact.out), 'utf8')
      } catch {
        // Only ENOENT (not yet generated) is expected; a present-but-unreadable
        // file is not a state this repo produces. Either way the remedy is the
        // same — regenerate — so treat a read failure as "stale".
        committed = null
      }
      return committed !== artifact.content
    })
    if (stale.length === 0) {
      console.log(`gen-persistence-catalog: ${artifacts.map(a => a.out).join(', ')} are up to date.`)
      process.exit(0)
    }
    console.error(`gen-persistence-catalog: ${stale.map(a => a.out).join(', ')} stale. Run \`pnpm run gen-persistence-catalog\` and commit the result.`)
    process.exit(1)
  }

  for (const artifact of artifacts) {
    writeFileSync(resolve(root, artifact.out), artifact.content)
    console.log(`gen-persistence-catalog: wrote ${artifact.out}.`)
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
