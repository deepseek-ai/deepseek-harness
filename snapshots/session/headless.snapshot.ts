/** Recorded-session replay through the shipped headless `dsh` profile. */

import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { basename, delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import {
  assertPersistedSessionVersion,
  assertSessionFixtureVersion,
  captureExpectedWorkspaceSnapshot,
  captureWorkspaceSnapshot,
  fixtureContext,
  formatSystemPromptSnapshot,
  formatToolSchemasSnapshot,
  latestPersistedSessionPaths,
  materializeProfilePatch,
  normalizeSessionSnapshots,
  normalizedHeaders,
  normalizedSystemPrompts,
  normalizedToolSchemas,
  parseSnapshotManifest,
  parseToolSchemasSnapshot,
  redactSessionSnapshotIds,
  refreshFixtureReplacements,
  restorePinnedToolSchemas,
  scrubSessionSnapshot,
  scrubSystemPrompts,
  scrubToolSchemas,
  sessionFixtureName,
  sessionFixtureNames,
  sessionHeaderVersion,
  snapshotSpillRoot,
  stabilizeFixtureMessageIds,
  stabilizeRefreshLog,
  tokenizeSessionFixtureCwd,
  writesCurrentSessionFixtures,
  type HarvestedLog,
  type NormalizeContext,
  type SnapshotManifest,
  type WorkspaceSnapshotEntry,
} from '@deepseek-ai/dsh-session-snapshot'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import { parseSessionLog, prepareSessionSnapshotFixtureForComparison } from '@deepseek-ai/dsh-llm-replay'

const repoRoot = fileURLToPath(new URL('../../', import.meta.url))
const snapshotsRoot = fileURLToPath(new URL('./', import.meta.url))
const dshBin = join(repoRoot, 'apps/cli/src/bin.ts')
const tsconfigPath = join(repoRoot, 'tsconfig.json')
const editingCordisSkill = join(
  repoRoot,
  'packages/preset/agent-presets/presets/cordis/skills/editing-cordis-compositions/SKILL.md',
)

type SnapshotMode = 'replay' | 'record' | 'refresh'

function snapshotMode(value: string | undefined): SnapshotMode {
  switch (value) {
    case undefined:
    case '':
    case 'replay': return 'replay'
    case 'record': return 'record'
    case 'refresh': return 'refresh'
    default: throw new Error(`unknown DSH_SNAPSHOT mode: ${value}`)
  }
}

const mode = snapshotMode(process.env.DSH_SNAPSHOT)
const RUNTIME_WORKSPACE_ENTRIES = ['.agents', '.dsh', '.snapshot-patches'] as const

interface JsonObject {
  [key: string]: unknown
}

interface HeadlessScenario {
  readonly name: string
  readonly dir: string
  readonly manifest: SnapshotManifest & {
    composition: string
    recording: 'live' | 'authored'
    header: NonNullable<SnapshotManifest['header']>
  }
}

interface SessionLog {
  readonly content: string
  readonly header: JsonObject
}

function propertyName(node: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(node) || ts.isStringLiteral(node) || ts.isNumericLiteral(node)) return node.text
  return undefined
}

function bindsOsAssignedPort(argument: ts.Expression | undefined): boolean {
  if (argument === undefined) return false
  if (ts.isNumericLiteral(argument)) return Number(argument.text) === 0
  if (!ts.isObjectLiteralExpression(argument)) return false
  let portIsZero: boolean | undefined
  for (const property of argument.properties) {
    if (ts.isSpreadAssignment(property)) {
      portIsZero = undefined
      continue
    }
    if (propertyName(property.name) !== 'port') continue
    portIsZero = ts.isPropertyAssignment(property)
      && ts.isNumericLiteral(property.initializer)
      && Number(property.initializer.text) === 0
  }
  return portIsZero === true
}

function listenerPortViolations(path: string, sourceText: string): string[] {
  const source = ts.createSourceFile(path, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const violations: string[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'listen'
      && !bindsOsAssignedPort(node.arguments[0])) {
      const line = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1
      const received = node.arguments[0]?.getText(source) ?? '<missing>'
      violations.push(
        `${path}:${line}: listener port ${received} must use listen(0, ...) or listen({ port: 0, ... })`,
      )
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return violations
}

function harvested(log: SessionLog): HarvestedLog {
  return {
    id: String(log.header.id),
    createdAt: Number(log.header.createdAt),
    ...(typeof log.header.parentSession === 'string' ? { parentSession: log.header.parentSession } : {}),
    content: log.content,
  }
}

function records(log: string): JsonObject[] {
  return log.split(/\r?\n/)
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as JsonObject)
}

function headerOf(log: string): JsonObject {
  return records(log)[0] ?? {}
}

function contextOf(logs: readonly string[]): NormalizeContext {
  const headers = logs.map(headerOf)
  return {
    sessionIds: headers.flatMap(header => typeof header.id === 'string' ? [header.id] : []),
    cwd: typeof headers[0]?.cwd === 'string' ? headers[0].cwd : '\0missing-cwd\0',
  }
}

async function persistedSessions(cwd: string): Promise<SessionLog[]> {
  const root = join(cwd, '.dsh', 'sessions')
  const files = latestPersistedSessionPaths(await readdir(root, { recursive: true }))
  const logs = await Promise.all(files.map(async (file): Promise<SessionLog> => {
    const content = await readFile(join(root, file), 'utf8')
    assertPersistedSessionVersion(basename(file), content)
    return { content, header: headerOf(content) }
  }))
  return logs.sort((left, right) => {
    const leftChild = typeof left.header.parentSession === 'string'
    const rightChild = typeof right.header.parentSession === 'string'
    if (leftChild !== rightChild) return leftChild ? 1 : -1
    return Number(left.header.createdAt) - Number(right.header.createdAt)
  })
}

async function fixtureSessions(scenario: HeadlessScenario): Promise<string[]> {
  const files = sessionFixtureNames(await readdir(scenario.dir))
  return Promise.all(files.map(async (file) => {
    const content = await readFile(join(scenario.dir, file), 'utf8')
    assertSessionFixtureVersion(file, content)
    return content
  }))
}

async function primaryFixtureFile(dir: string): Promise<string> {
  const [primary] = sessionFixtureNames(await readdir(dir))
  if (primary === undefined) throw new Error(`${dir}: missing parent Session fixture`)
  const content = await readFile(join(dir, primary), 'utf8')
  assertSessionFixtureVersion(primary, content)
  return primary
}

async function writeSessionFixtures(
  scenario: HeadlessScenario,
  actualLogs: readonly SessionLog[],
  existing: readonly string[],
  ctx: NormalizeContext,
): Promise<string[]> {
  const names = actualLogs.map((log, index) => sessionFixtureName(
    index,
    sessionHeaderVersion(log.content, `harvested Session ${index}`),
  ))
  const prior = names.map((_, index) => existing[index] ?? '')
  const replacements = mode === 'refresh'
    ? refreshFixtureReplacements(actualLogs.map(harvested), prior)
    : []
  const fresh = actualLogs.map((log, index) => {
    const stable = tokenizeSessionFixtureCwd(mode === 'refresh'
      ? stabilizeRefreshLog(log.content, prior[index] as string, replacements, ctx)
      : log.content)
    return scrubSessionSnapshot(prepareSessionSnapshotFixtureForComparison(stable))
  })
  const output = redactSessionSnapshotIds(stabilizeFixtureMessageIds(fresh, prior))
  await Promise.all(output.map((content, index) => writeFile(join(scenario.dir, names[index] as string), content)))
  return output
}

/**
 * Write prompt and tool-schema sidecars independently of Session-generation retention.
 * @param scenario - scenario and sidecar ownership metadata.
 * @param actualLogs - current run's primary-first Session logs.
 * @param ctx - volatile run values used by header normalization.
 */
async function writeHeaderSidecars(
  scenario: HeadlessScenario,
  actualLogs: readonly SessionLog[],
  ctx: NormalizeContext,
): Promise<void> {
  if (scenario.manifest.header.pin === true) {
    const primary = actualLogs[0]
    if (primary === undefined) throw new Error(`${scenario.name}: write-back has no primary session`)
    const prompts = normalizedSystemPrompts(primary.content, ctx)
    const schemas = normalizedToolSchemas(primary.content, ctx)
    const promptOwner = scenario.manifest.header.systemPromptSource ?? scenario.name
    const schemaOwner = scenario.manifest.header.toolSchemasSource ?? scenario.name
    if (promptOwner === scenario.name) {
      await writeFile(
        join(scenario.dir, 'system-prompt.expected.md'),
        formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1)),
      )
    }
    if (schemaOwner === scenario.name) {
      await writeFile(
        join(scenario.dir, 'tool-schemas.expected.json'),
        formatToolSchemasSnapshot(schemas[0] as unknown[], schemas.slice(1)),
      )
    }
  }
  for (const index of scenario.manifest.header.childSystemPrompts ?? []) {
    const child = actualLogs[index]
    if (child === undefined) throw new Error(`${scenario.name}: write-back has no child ${index} prompt`)
    const prompts = normalizedSystemPrompts(child.content, ctx)
    await writeFile(
      join(scenario.dir, `system-prompt.${index}.expected.md`),
      formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1)),
    )
  }
  for (const index of scenario.manifest.header.childToolSchemas ?? []) {
    const child = actualLogs[index]
    if (child === undefined) throw new Error(`${scenario.name}: write-back has no child ${index} schemas`)
    const schemas = normalizedToolSchemas(child.content, ctx)
    await writeFile(
      join(scenario.dir, `tool-schemas.${index}.expected.json`),
      formatToolSchemasSnapshot(schemas[0] as unknown[], schemas.slice(1)),
    )
  }
}

function taskFromSession(log: string): string | undefined {
  const text = (value: unknown): string | undefined => {
    if (value === null || typeof value !== 'object') return undefined
    const message = value as JsonObject
    const source = message.source as JsonObject | undefined
    if (source?.kind !== 'user' || !Array.isArray(message.content)) return undefined
    const blocks = message.content as JsonObject[]
    return blocks.length === 1 && blocks[0]?.type === 'text' && typeof blocks[0].text === 'string'
      ? blocks[0].text
      : undefined
  }
  // Inbox text retains canonical mentions that pre-step renders as readable labels.
  for (const record of records(log)) {
    if (record.type !== 'agent/inbox/spliced') continue
    const data = record.data as JsonObject | undefined
    if (!Array.isArray(data?.inserted)) continue
    for (const message of data.inserted) {
      const task = text(message)
      if (task !== undefined) return task
    }
  }
  for (const record of records(log)) {
    if (record.type !== 'user/message') continue
    const task = text(record.data)
    if (task !== undefined) return task
  }
  return undefined
}

function finalTextFromSession(log: string): string {
  const messages = records(log).flatMap((record) => {
    if (record.type !== 'assistant/message') return []
    const data = record.data as JsonObject | undefined
    const message = data?.message as JsonObject | undefined
    return message === undefined ? [] : [message]
  })
  const content = messages.at(-1)?.content
  if (!Array.isArray(content)) return ''
  return (content as JsonObject[])
    .flatMap(block => block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('')
}

function turnReasonFromSession(log: string): JsonObject | undefined {
  const endings = records(log).flatMap((record) => {
    if (record.type !== 'turn/end') return []
    const data = record.data as JsonObject | undefined
    return data?.reason !== null && typeof data?.reason === 'object'
      ? [data.reason as JsonObject]
      : []
  })
  return endings.at(-1)
}

function stderrFromSession(log: string): string {
  let output = ''
  let started = false
  let open = false
  let endsWithNewline = true
  const appendReasoning = (text: string): void => {
    if (text === '') return
    if (!open) {
      output += 'dsh: reasoning:\n'
      open = true
    }
    output += text
    endsWithNewline = text.endsWith('\n')
  }
  const close = (): void => {
    if (!open) return
    if (!endsWithNewline) output += '\n'
    open = false
    endsWithNewline = true
  }
  const consume = (type: unknown, data: JsonObject | undefined): void => {
    if (type === 'reasoning-chunks') {
      if (!Array.isArray(data?.texts) || data.texts.some(text => typeof text !== 'string')) {
        throw new Error('headless snapshot reasoning chunks have invalid text')
      }
      for (const text of data.texts as string[]) appendReasoning(text)
      return
    }
    if (type === 'text-chunks' || type === 'tool-call-chunks') {
      close()
      return
    }
    if (type !== 'assistant/chunk' && type !== 'chunk') return
    const chunk = data?.chunk as JsonObject | undefined
    switch (chunk?.type) {
      case 'reasoning-delta':
        if (typeof chunk.text !== 'string') throw new Error('headless snapshot reasoning delta has invalid text')
        appendReasoning(chunk.text)
        break
      case 'block-start':
        if (chunk.blockType !== 'reasoning') close()
        break
      case 'block-end': {
        const block = chunk.block as JsonObject | undefined
        if (block?.type !== 'reasoning') close()
        break
      }
      case 'usage':
        break
      case 'text-delta':
      case 'tool-call-delta':
      case 'finish':
        close()
        break
    }
  }
  for (const record of records(log)) {
    if (record.type === 'turn/start') {
      close()
      started = true
      continue
    }
    if (!started) continue
    const data = record.data as JsonObject | undefined
    if ((record.type === 'assistant/message' || record.type === 'assistant/attempt')
      && Array.isArray(data?.stream)) {
      for (const entry of data.stream) {
        if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
          throw new Error('headless snapshot embedded stream has an invalid entry')
        }
        const streamRecord = entry as JsonObject
        consume(streamRecord.type, streamRecord)
      }
      close()
      continue
    }
    consume(record.type, data)
  }
  close()
  const reason = turnReasonFromSession(log)
  if (reason?.kind !== 'error') return output
  const error = reason.error as JsonObject | undefined
  if (typeof error?.code !== 'string' || typeof error.message !== 'string') {
    throw new Error('headless snapshot error reason has no code and message')
  }
  return `${output}dsh: ${error.code}: ${error.message}\n`
}

function modelFromSession(log: string): { provider: string; model: string } {
  for (const record of records(log)) {
    if (record.type !== 'request/header') continue
    const data = record.data as JsonObject | undefined
    const header = data?.header as JsonObject | undefined
    const config = header?.config as JsonObject | undefined
    if (typeof config?.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  }
  throw new Error('headless snapshot session has no request model')
}

async function seedWorkspace(scenario: HeadlessScenario, cwd: string): Promise<void> {
  const source = join(scenario.dir, 'workspace')
  if (existsSync(source)) {
    for (const entry of await readdir(source)) {
      await cp(join(source, entry), join(cwd, entry), { recursive: true, verbatimSymlinks: true })
    }
  }
  const setup = scenario.manifest.workspace?.setup
  if (setup === undefined) return
  const prepare = workspaceSetups[setup]
  if (prepare === undefined) throw new Error(`${scenario.name}: unknown workspace setup ${setup}`)
  await prepare(cwd)
}

const workspaceSetups: Record<string, (cwd: string) => Promise<void>> = {
  async 'editing-cordis-skill'(cwd) {
    const target = join(cwd, '.dsh', 'skills', 'editing-cordis-compositions', 'SKILL.md')
    await mkdir(dirname(target), { recursive: true })
    await copyFile(editingCordisSkill, target)
  },
  async 'delimiter-path'(cwd) {
    const dir = join(cwd, 'scope</system-reminder>')
    await mkdir(dir, { recursive: true })
    await Promise.all([
      writeFile(join(dir, 'AGENTS.md'), 'Delimiter path snapshot instruction.\n'),
      writeFile(join(dir, 'task.txt'), 'delimiter path snapshot task\n'),
    ])
  },
  async 'fixed-search-mtimes'(cwd) {
    const tree = join(cwd, 'tree')
    const files = [
      join('archive', 'a.ts'),
      join('archive', 'b.ts'),
      join('archive', 'c.ts'),
      join('docs', 'guide.md'),
      join('src', 'index.ts'),
      join('test', 'spec.ts'),
      'top.txt',
      'notes.md',
    ]
    for (const [index, relative] of files.entries()) {
      const target = join(tree, relative)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, 'fixture\n')
      const mtime = new Date(2000, 0, 1, 0, 0, 0, index + 1)
      await utimes(target, mtime, mtime)
    }
  },
}

async function collectScenarios(): Promise<HeadlessScenario[]> {
  const scenarios: HeadlessScenario[] = []
  for (const entry of await readdir(snapshotsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const dir = join(snapshotsRoot, entry.name)
    const manifestPath = join(dir, 'snapshot.yml')
    if (!existsSync(manifestPath)) continue
    const manifest = parseSnapshotManifest(await readFile(manifestPath, 'utf8'), manifestPath)
    if (manifest.profile !== 'headless' || manifest.composition === undefined) continue
    if (manifest.recording === undefined || manifest.header === undefined) {
      throw new Error(`${entry.name}: a headless corpus manifest needs recording and header metadata`)
    }
    scenarios.push({
      name: entry.name,
      dir,
      manifest: { ...manifest, composition: manifest.composition, recording: manifest.recording, header: manifest.header },
    })
  }
  return scenarios.sort((left, right) => left.name.localeCompare(right.name))
}

const scenarios = await collectScenarios()
const hasPwsh = spawnSync(
  resolvePwshPath(),
  ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'],
  { encoding: 'utf8' },
).status === 0
const scenarioByName = new Map(scenarios.map(scenario => [scenario.name, scenario]))
const compositionOwners = new Map<string, HeadlessScenario>()
const headerPins = new Map<string, HeadlessScenario>()
for (const scenario of scenarios) {
  const { composition, header } = scenario.manifest
  if (existsSync(join(scenario.dir, 'cordis.yml'))) {
    if (compositionOwners.has(composition)) throw new Error(`headless composition ${composition} has multiple patch owners`)
    compositionOwners.set(composition, scenario)
  }
  if (header.pin === true) {
    const key = `${composition}/${header.class}`
    if (headerPins.has(key)) throw new Error(`headless header class ${key} has multiple pins`)
    headerPins.set(key, scenario)
  }
}

function ownerOf(scenario: HeadlessScenario): HeadlessScenario {
  const owner = compositionOwners.get(scenario.manifest.composition)
  if (owner === undefined) throw new Error(`${scenario.name}: composition has no cordis.yml owner`)
  return owner
}

function pinOf(scenario: HeadlessScenario): HeadlessScenario {
  const { composition, header } = scenario.manifest
  const pin = headerPins.get(`${composition}/${header.class}`)
  if (pin === undefined) throw new Error(`${scenario.name}: composition/header class has no pin`)
  return pin
}

async function verifyHeaders(scenario: HeadlessScenario, actualLogs: readonly SessionLog[], ctx: NormalizeContext): Promise<void> {
  const pin = pinOf(scenario)
  const fixture = await readFile(join(pin.dir, await primaryFixtureFile(pin.dir)), 'utf8')
  const pinned = normalizedHeaders(fixture, fixtureContext(fixture))
  const changes = pin.manifest.header.changes ?? 0
  expect(pinned, `${scenario.name}: pin header count`).toHaveLength(1 + changes)

  const promptOwner = scenarioByName.get(pin.manifest.header.systemPromptSource ?? pin.name)
  const schemaOwner = scenarioByName.get(pin.manifest.header.toolSchemasSource ?? pin.name)
  if (promptOwner === undefined || schemaOwner === undefined) {
    throw new Error(`${scenario.name}: header sidecar source is not a headless scenario`)
  }
  const prompt = await readFile(join(promptOwner.dir, 'system-prompt.expected.md'), 'utf8')
  const schemas = parseToolSchemasSnapshot(await readFile(join(schemaOwner.dir, 'tool-schemas.expected.json'), 'utf8'))
  const schemaSets = [schemas.initial, ...schemas.changes]
  expect(schemaSets, `${scenario.name}: pin tool-schema count`).toHaveLength(pinned.length)
  const reconstructed = pinned.map((header, index) => restorePinnedToolSchemas(
    header,
    schemaSets[index] as unknown[],
  ))

  const childPrompts = new Map<number, string>()
  const childSchemas = new Map<number, unknown[][]>()
  for (const index of scenario.manifest.header.childSystemPrompts ?? []) {
    childPrompts.set(index, await readFile(join(scenario.dir, `system-prompt.${index}.expected.md`), 'utf8'))
  }
  for (const index of scenario.manifest.header.childToolSchemas ?? []) {
    const child = parseToolSchemasSnapshot(await readFile(join(scenario.dir, `tool-schemas.${index}.expected.json`), 'utf8'))
    childSchemas.set(index, [child.initial, ...child.changes])
  }

  for (const [logIndex, log] of actualLogs.entries()) {
    const headers = normalizedHeaders(scrubSystemPrompts(log.content), ctx)
    const prompts = normalizedSystemPrompts(log.content, ctx)
    expect(prompts, `${scenario.name}: every header has a system prompt`).toHaveLength(headers.length)
    for (const [index, header] of headers.entries()) {
      const selectedSchemas = childSchemas.get(logIndex)?.[index]
      const base = reconstructed[index] ?? reconstructed[0]
      const expected = selectedSchemas === undefined ? base : { ...base as JsonObject, tools: selectedSchemas }
      expect(header, `${scenario.name}: request header ${index + 1}`).toEqual(expected)
    }
    if (prompts.length > 0) {
      expect(
        formatSystemPromptSnapshot(prompts[0] as string, prompts.slice(1)),
        `${scenario.name}: system prompts`,
      ).toBe(childPrompts.get(logIndex) ?? prompt)
    }
  }
}

describe('headless recorded-session snapshots', () => {
  it('gives every composition and header class exactly one pin', () => {
    for (const scenario of scenarios) {
      expect(ownerOf(scenario), `${scenario.name}: composition owner`).toBeDefined()
      expect(pinOf(scenario), `${scenario.name}: header pin`).toBeDefined()
    }
  })

  it('recognizes the supported OS-assigned listener forms', () => {
    expect(listenerPortViolations('accepted.mjs', [
      "server.listen(0, '127.0.0.1')",
      "server.listen({ port: 0, host: '127.0.0.1' })",
      'server.listen({ ...options, port: 0 })',
    ].join('\n'))).toEqual([])
    expect(listenerPortViolations('fixed.mjs', 'server.listen(43118)')).toEqual([
      'fixed.mjs:1: listener port 43118 must use listen(0, ...) or listen({ port: 0, ... })',
    ])
    expect(listenerPortViolations('dynamic.mjs', 'server.listen({ port, ...options })')).toEqual([
      'dynamic.mjs:1: listener port { port, ...options } must use listen(0, ...) or listen({ port: 0, ... })',
    ])
  })

  it('binds scenario HTTP fixtures only to OS-assigned ports', async () => {
    const fixtureNames = (await readdir(snapshotsRoot, { recursive: true })).filter(name => name.endsWith('.mjs'))
    const violations = (await Promise.all(fixtureNames.map(async (fixtureName) => listenerPortViolations(
      fixtureName,
      await readFile(join(snapshotsRoot, fixtureName), 'utf8'),
    )))).flat()
    expect(violations).toEqual([])
  })

  it('stores session-owned inputs with typed redaction and no ACP transcript', async () => {
    for (const scenario of scenarios) {
      const fixtures = await fixtureSessions(scenario)
      expect(redactSessionSnapshotIds(fixtures), `${scenario.name}: identity redaction fixed point`).toEqual(fixtures)
      for (const fixture of fixtures) {
        expect(scrubSystemPrompts(fixture), `${scenario.name}: system prompt stays in a sidecar`).toBe(fixture)
        expect(scrubToolSchemas(fixture), `${scenario.name}: tool schemas stay in a sidecar`).toBe(fixture)
      }
      expect(existsSync(join(scenario.dir, 'input.json')), `${scenario.name}: task comes from session JSONL`).toBe(false)
      expect(existsSync(join(scenario.dir, 'stdout.expected.jsonl')), `${scenario.name}: no ACP transcript`).toBe(false)
    }
  })

  it('keeps packed chunk rows logically equal to their unpacked recording', async () => {
    const sourceDir = join(snapshotsRoot, 'hook-cc-pretool-deny')
    const packedDir = join(snapshotsRoot, 'packed-chunks')
    const source = await readFile(join(sourceDir, await primaryFixtureFile(sourceDir)), 'utf8')
    const packed = await readFile(join(packedDir, await primaryFixtureFile(packedDir)), 'utf8')
    const rowTypes = records(packed).flatMap((record) => {
      const type = record.type
      return type === 'text-chunks' || type === 'reasoning-chunks' || type === 'tool-call-chunks' ? [type] : []
    })
    expect([...new Set(rowTypes)].sort()).toStrictEqual(['reasoning-chunks', 'text-chunks', 'tool-call-chunks'])

    const withoutVolatileMessage = (event: unknown): unknown => {
      const cloned = structuredClone(event) as {
        time?: unknown
        type?: unknown
        data?: {
          durationMs?: unknown
          id?: unknown
          inserted?: Array<{ id?: unknown }>
          message?: { id?: unknown }
          stream?: Array<{ time?: number; time0?: number; dt?: number[] }>
        }
      }
      delete cloned.time
      if (cloned.type === 'agent/inbox/spliced') {
        for (const message of cloned.data?.inserted ?? []) delete message.id
      }
      if (cloned.type === 'user/message') delete cloned.data?.id
      if (cloned.type === 'assistant/message' || cloned.type === 'tool/result') delete cloned.data?.message?.id
      if (cloned.type === 'assistant/message' || cloned.type === 'assistant/attempt') {
        for (const record of cloned.data?.stream ?? []) {
          if (record.time !== undefined) record.time = 0
          if (record.time0 !== undefined) record.time0 = 0
          if (record.dt !== undefined) record.dt = record.dt.map(() => 0)
        }
      }
      if (cloned.type === 'hook/result') delete cloned.data?.durationMs
      return cloned
    }
    const logical = (fixture: string): unknown[] => {
      const current = prepareSessionSnapshotFixtureForComparison(fixture)
      return [
        records(current)[0],
        ...parseSessionLog(current).map(withoutVolatileMessage),
      ]
    }
    expect(logical(packed)).toStrictEqual(logical(source))
  })

  it('replays original inbox mentions before normalized user messages', () => {
    const message = (text: string) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
    const original = 'Use @[Research](dsh-session:InJlZmVyZW5jZS1zb3VyY2Ui)'
    const log = [
      { type: 'agent/inbox/spliced', data: { inserted: [message(original)] } },
      { type: 'user/message', data: message('Use @Research') },
    ].map(record => JSON.stringify(record)).join('\n')
    expect(taskFromSession(log)).toBe(original)
    expect(taskFromSession(JSON.stringify({ type: 'user/message', data: message('legacy task') }))).toBe('legacy task')
  })

  it('reconstructs reasoning stderr across packed output boundaries', () => {
    const log = [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'reasoning-chunks', data: { texts: ['first', ''] } },
      { type: 'text-chunks', data: { texts: ['text'] } },
      { type: 'reasoning-chunks', data: { texts: ['second'] } },
      { type: 'tool-call-chunks', data: { args: ['{}'] } },
      { type: 'reasoning-chunks', data: { texts: ['third\n'] } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map(record => JSON.stringify(record)).join('\n')

    expect(stderrFromSession(log)).toBe([
      'dsh: reasoning:',
      'first',
      'dsh: reasoning:',
      'second',
      'dsh: reasoning:',
      'third',
      '',
    ].join('\n'))
  })

  it.each(['assistant/message', 'assistant/attempt'] as const)(
    'reconstructs reasoning stderr from embedded current %s streams',
    (eventType) => {
      const log = [
        { type: 'turn/start', data: { turn: 1 } },
        {
          type: eventType,
          data: {
            stream: [
              { type: 'chunk', chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
              { type: 'reasoning-chunks', texts: ['first', ' thought'] },
              { type: 'chunk', chunk: { type: 'block-start', index: 1, blockType: 'text' } },
            ],
          },
        },
        { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      ].map(record => JSON.stringify(record)).join('\n')

      expect(stderrFromSession(log)).toBe('dsh: reasoning:\nfirst thought\n')
    },
  )

  it('closes reasoning between embedded Assistant settlements', () => {
    const log = [
      { type: 'turn/start', data: { turn: 1 } },
      {
        type: 'assistant/attempt',
        data: { stream: [{ type: 'reasoning-chunks', texts: ['first', ' thought'] }] },
      },
      {
        type: 'assistant/message',
        data: {
          stream: [
            { type: 'chunk', chunk: { type: 'reasoning-delta', index: 0, text: 'second' } },
            { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } },
          ],
        },
      },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ].map(record => JSON.stringify(record)).join('\n')

    expect(stderrFromSession(log)).toBe('dsh: reasoning:\nfirst thought\ndsh: reasoning:\nsecond\n')
  })

  it('writes header sidecars without replacing a retained Session generation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'dsh-headless-sidecars-'))
    try {
      const scenario: HeadlessScenario = {
        name: 'retained-pin',
        dir: directory,
        manifest: {
          version: 1,
          scenario: 'retained-pin',
          profile: 'headless',
          composition: 'default',
          recording: 'live',
          header: { class: 'default', pin: true },
          sessionFormat: { version: 1, coverage: ['adjacent-migration'] },
        },
      }
      const header = {
        type: 'session', version: 2, id: 'sidecar-session', createdAt: 1,
        cwd: '/tmp/sidecar-session', isSeeded: false, delegationDepth: 0,
      }
      const content = [
        header,
        { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
        {
          type: 'request/header',
          seq: 1,
          time: 3,
          data: {
            header: {
              config: { provider: 'test', model: 'test' },
              system: 'fresh system prompt',
              tools: [{ name: 'fresh_tool', description: 'fresh schema', parameters: {} }],
            },
            reason: 'initial',
          },
        },
      ].map(record => JSON.stringify(record)).join('\n')
      const retained = '{"type":"session","version":1}\n'
      await writeFile(join(directory, 'session.v1.jsonl'), retained)

      await writeHeaderSidecars(
        scenario,
        [{ content, header }],
        { sessionIds: ['sidecar-session'], cwd: '/tmp/sidecar-session' },
      )

      expect(await readFile(join(directory, 'system-prompt.expected.md'), 'utf8'))
        .toBe('fresh system prompt\n')
      expect(await readFile(join(directory, 'tool-schemas.expected.json'), 'utf8'))
        .toContain('"name": "fresh_tool"')
      expect(await readFile(join(directory, 'session.v1.jsonl'), 'utf8')).toBe(retained)
      expect(await readdir(directory)).not.toContain('session.v2.jsonl')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  for (const scenario of scenarios) {
    const skipped = scenario.manifest.platform === 'posix' && process.platform === 'win32'
      || scenario.manifest.platform === 'pwsh' && !hasPwsh
      || mode === 'record' && scenario.manifest.recording === 'authored'
      || mode === 'record' && scenario.manifest.sessionFormat !== undefined
    const scenarioTest = skipped ? it.skip : mode === 'replay' ? it.concurrent : it
    scenarioTest(`${mode}s ${scenario.name} through dsh --profile headless`, async () => {
      let fixtures = await fixtureSessions(scenario)
      const primaryFixture = fixtures[0]
      if (primaryFixture === undefined) throw new Error(`${scenario.name}: missing primary session fixture`)
      const task = taskFromSession(primaryFixture) ?? scenario.manifest.input?.task
      if (task === undefined) throw new Error(`${scenario.name}: no accepted or exceptional task input`)
      const pin = pinOf(scenario)
      let model: { provider: string; model: string }
      try {
        model = modelFromSession(primaryFixture)
      } catch {
        model = modelFromSession(await readFile(join(pin.dir, await primaryFixtureFile(pin.dir)), 'utf8'))
      }
      const composition = ownerOf(scenario)
      const baseComposition = compositionOwners.get('default')
      if (baseComposition === undefined) throw new Error('headless corpus has no default composition')
      let fixtureFiles = sessionFixtureNames(await readdir(scenario.dir))
      const replaying = mode !== 'record'
      const compositionPatch = join(composition.dir, replaying ? 'cordis.snapshot.yml' : 'cordis.yml')
      const patchSources = [
        join(baseComposition.dir, 'cordis.yml'),
        ...composition === baseComposition && !replaying ? [] : [compositionPatch],
        join(baseComposition.dir, 'model.cordis.yml'),
      ]
      const patchRoot = '.snapshot-patches'
      const patches = patchSources.map((source, index) => source.endsWith('.snapshot.yml')
        ? join(patchRoot, `${String(index)}-${basename(source)}`)
        : source)

      let actualLogs: SessionLog[] = []
      let initialWorkspace: WorkspaceSnapshotEntry[] | undefined
      let finalWorkspace: WorkspaceSnapshotEntry[] | undefined
      const spillRoot = snapshotSpillRoot(join(scenario.dir, fixtureFiles[0] as string))
      await rm(spillRoot, { recursive: true, force: true })
      let result: Awaited<ReturnType<typeof runLoaderSmoke>>
      try {
        result = await runLoaderSmoke({
          label: `${scenario.name} headless snapshot`,
          tempDirPrefix: 'dsh-log-snap-',
          ...(scenario.manifest.workspace?.parent === 'home' ? { tempDirParent: homedir() } : {}),
          binScript: dshBin,
          configPath: join(baseComposition.dir, 'cordis.yml'),
          binArgs: [
            '--profile', 'headless',
            ...patches.flatMap(file => ['--patch', file]),
            task,
          ],
          tsconfigPath,
          expectedExitCode: turnReasonFromSession(primaryFixture)?.kind === 'completed'
            || turnReasonFromSession(primaryFixture) === undefined && scenario.manifest.input?.task !== undefined
            ? 0
            : 1,
          env: {
            DSH_SNAPSHOT: replaying ? 'replay' : 'record',
            DSH_SNAPSHOT_PROVIDER: model.provider,
            DSH_SNAPSHOT_MODEL: model.model,
            DSH_SNAPSHOT_SPILL_ROOT: spillRoot,
            DSH_SNAPSHOT_FILE: join(scenario.dir, fixtureFiles[0] as string),
            ...(replaying && fixtureFiles.length > 1
              ? { DSH_SNAPSHOT_CHILD_FILES: fixtureFiles.slice(1).map(file => join(scenario.dir, file)).join(delimiter) }
              : {}),
            ...(replaying && scenario.manifest.replay?.override === true
              ? { DSH_SNAPSHOT_OVERRIDE: join(scenario.dir, 'replay.override.json') }
              : {}),
            ...(scenario.manifest.permission === undefined
              ? {}
              : { DSH_PERMISSION_MODE: scenario.manifest.permission }),
            ...scenario.manifest.environment,
            NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
            DSH_TELEMETRY_DISABLED: '1',
          },
          prepare: async (cwd) => {
            await mkdir(join(cwd, patchRoot), { recursive: true })
            patchSources.forEach((source, index) => {
              if (source.endsWith('.snapshot.yml')) {
                materializeProfilePatch(source, cwd, join(cwd, patchRoot), index)
              }
            })
            await seedWorkspace(scenario, cwd)
            initialWorkspace = await captureWorkspaceSnapshot(cwd, {
              ignoredRootEntries: RUNTIME_WORKSPACE_ENTRIES,
            })
          },
          inspect: async (cwd) => {
            actualLogs = await persistedSessions(cwd)
            finalWorkspace = await captureWorkspaceSnapshot(cwd, {
              ignoredRootEntries: RUNTIME_WORKSPACE_ENTRIES,
            })
          },
        })
      } finally {
        await rm(spillRoot, { recursive: true, force: true })
      }

      const stderrLog = mode === 'replay' ? primaryFixture : actualLogs[0]?.content
      if (stderrLog === undefined) throw new Error(`${scenario.name}: stderr projection has no primary session`)
      const expectedStderr = stderrFromSession(stderrLog)
      const actualContext = contextOf(actualLogs.map(log => log.content))

      if (writesCurrentSessionFixtures(scenario.manifest, mode)) {
        fixtures = await writeSessionFixtures(
          scenario,
          actualLogs,
          fixtures,
          actualContext,
        )
        fixtureFiles = actualLogs.map((log, index) => sessionFixtureName(
          index,
          sessionHeaderVersion(log.content, `harvested Session ${index}`),
        ))
      }
      if (mode !== 'replay') await writeHeaderSidecars(scenario, actualLogs, actualContext)

      expect(result.stdout).toBe(`${finalTextFromSession(fixtures[0] as string)}\n`)
      expect(result.stderr).toBe(expectedStderr)
      expect(actualLogs, `${scenario.name}: persisted session count`).toHaveLength(fixtures.length)
      const fixtureContext = contextOf(fixtures)
      const actualSnapshots = normalizeSessionSnapshots(actualLogs.map(log => log.content), actualContext)
      const expectedSnapshots = normalizeSessionSnapshots(fixtures, fixtureContext)
      for (const [index, actual] of actualSnapshots.entries()) {
        expect(actual, `${scenario.name}: session ${index}`).toBe(expectedSnapshots[index])
      }
      await verifyHeaders(scenario, actualLogs, actualContext)

      if (initialWorkspace === undefined || finalWorkspace === undefined) {
        throw new Error(`${scenario.name}: workspace was not captured around the profile run`)
      }
      if (scenario.manifest.workspace?.final === true) {
        const expectedWorkspace = await captureExpectedWorkspaceSnapshot(join(scenario.dir, 'workspace.expected'))
        expect(finalWorkspace, `${scenario.name}: complete final workspace`).toEqual(expectedWorkspace)
      } else {
        expect(finalWorkspace, `${scenario.name}: a changed workspace requires workspace.final`).toEqual(initialWorkspace)
      }
    }, LOADER_SMOKE_TEST_TIMEOUT_MS)
  }
})
