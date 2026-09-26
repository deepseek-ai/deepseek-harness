/** Recorded-session replay through the shipped headless `dsh` profile. */

import { startHttpMcpFixture } from '../../packages/mcp/mcp-client/tests/http-fixture.ts'
import { cp, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import ts from 'typescript'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { releasedV0SessionFormatCodec } from '@deepseek-ai/dsh-session-format-v0-to-v1'
import type { SessionFormatEvent, SessionFormatMigrationContext } from '@deepseek-ai/dsh-session-format'
import { assertWorkspaceOutsideTemp, outsideTempWorkspaceParent } from '../../scripts/snapshot-workspace-parent.ts'
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
  systemPromptPrecedesRequests,
  sessionFixtureNames,
  sessionHeaderVersion,
  writerSnapshotName,
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
  'packages/preset/agent-preset/skills/editing-cordis-compositions/SKILL.md',
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

/** Compare deterministic recorded tool output with raw writer fields; only message ids are volatile. */
function verifyToolResultWriterParity(fixture: string, actual: string): void {
  expect(sessionHeaderVersion(fixture, 'retained tool-result input')).toBe(3)
  expect(sessionHeaderVersion(actual, 'raw tool-result writer')).toBe(SESSION_FORMAT_VERSION)
  const withoutMessageId = (message: object): JsonObject => Object.fromEntries(
    Object.entries(message).filter(([key]) => key !== 'id'),
  )
  const expected = parseSessionLog(fixture).flatMap(event => event.type === 'tool/result'
    ? [withoutMessageId(event.data.message)] : [])
  const written = records(actual).flatMap(event => event.type === 'tool/result'
    ? [withoutMessageId((event.data as JsonObject).message as JsonObject)] : [])
  expect(expected.length, 'recorded stock tool results').toBeGreaterThan(0)
  expect(written, 'native tool-result messages match migration output').toEqual(expected)
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
    expect(assertPersistedSessionVersion(basename(file), content), `${file}: current writer`).toBe(SESSION_FORMAT_VERSION)
    return { content, header: headerOf(content) }
  }))
  // Siblings bind to fixture roles by catalog publication order; concurrent
  // provider startup can publish an older Session after a newer one.
  const catalogOrders = new Map(logs.map(log => [log.header.id, new Map(
    records(log.content)
      .filter(event => event.type === 'subagent/catalog')
      .map((event, index) => [(event.data as JsonObject).childId, index]),
  )]))
  return logs.sort((left, right) => {
    const leftChild = typeof left.header.parentSession === 'string'
    const rightChild = typeof right.header.parentSession === 'string'
    if (leftChild !== rightChild) return leftChild ? 1 : -1
    if (left.header.parentSession === right.header.parentSession) {
      const catalogOrder = catalogOrders.get(left.header.parentSession)
      const childOrder = (catalogOrder?.get(left.header.id) ?? Infinity) - (catalogOrder?.get(right.header.id) ?? Infinity)
      if (childOrder) return childOrder
    }
    return Number(left.header.createdAt) - Number(right.header.createdAt)
  })
}

async function fixtureSessions(scenario: HeadlessScenario, selectedFiles?: readonly string[]): Promise<string[]> {
  const files = selectedFiles ?? sessionFixtureNames(await readdir(scenario.dir))
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
  const names = actualLogs.map((log, index) => scenario.manifest.sessionFormat === undefined
    ? sessionFixtureName(index, sessionHeaderVersion(log.content, `harvested Session ${index}`))
    : writerSnapshotName(index))
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
  if (scenario.manifest.header.pin === true
    || [...headerPins.values()].some(pin => pin.manifest.header.systemPromptSource === scenario.name
      || pin.manifest.header.toolSchemasSource === scenario.name)) {
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
  async 'office-skills'(cwd) {
    await cp(join(repoRoot, 'packages/skill/skill-office/assets'), join(cwd, 'office-skills'), { recursive: true })
    await symlink(process.execPath, join(cwd, 'office-node'))
    await symlink(join(repoRoot, 'packages/skill/skill-office/node_modules/@deepseek-ai/libreoffice-kit/lib/cli.js'), join(cwd, 'office-cli.js'))
  },
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

function spillReferenceSource(events: readonly JsonObject[], label: string): JsonObject {
  const messages = events.filter((event) => {
    const source = (event.data as JsonObject | undefined)?.source as JsonObject | undefined
    return event.type === 'user/message' && source?.kind === 'session-reference'
  })
  expect(messages, `${label}: reference message count`).toHaveLength(1)
  const source = (messages[0]!.data as JsonObject).source as JsonObject
  expect(source).toMatchObject({ kind: 'session-reference', form: 'recall', version: 1 })
  const references = source.references as JsonObject[]
  expect(references, `${label}: referenced Session count`).toHaveLength(1)
  expect(references[0]?.sessionId, `${label}: referenced Session id`).toBe('reference-source')
  return references[0]!
}

function sessionReferenceSpillExpected(actual: readonly JsonObject[], expectedLog: string, recordedVersion: number): JsonObject[] {
  const expected = records(expectedLog)
  const actualReference = spillReferenceSource(actual, 'actual session-reference-spill')
  const expectedReference = spillReferenceSource(expected, 'expected session-reference-spill')
  // source-session.ts creates reference-source anew with Session.create() for each run.
  expect(actualReference.capturedFormatVersion, 'fresh reference-source generation').toBe(SESSION_FORMAT_VERSION)
  expect(expectedReference.capturedFormatVersion, 'recorded reference-source generation').toBe(recordedVersion)
  expectedReference.capturedFormatVersion = SESSION_FORMAT_VERSION
  return expected
}

/** Require successful verification and the complete canonical event before refresh can write a fixture. */
async function verifySessionQuerySpill(log: string, spillRoot: string, locatorRoot: string): Promise<void> {
  const events = parseSessionLog(log)
  const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
  const readResult = results.find(result => result.toolCallId === 'call_session_query_spill')
  const verification = results.find(result => result.toolCallId === 'call_verify_session_query_spill')
  expect(readResult?.isError).toBe(false)
  expect(verification).toMatchObject({
    isError: false,
    content: [{ type: 'text', text: 'SPILL_CANONICAL_OK\n' }],
  })
  const preview = readResult?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  const locator = preview?.match(/Full formatted result stored at: (.+-session_event_read\.txt)\. Use read/)
  expect(locator).not.toBeNull()
  expect(locator?.[1]).toBeDefined()
  expect(locator![1]!.startsWith(locatorRoot + sep)).toBe(true)
  const full = await readFile(join(spillRoot, relative(locatorRoot, locator![1]!)), 'utf8')
  const json = full.match(/```json\n([\s\S]+)\n```/)
  expect(json).not.toBeNull()
  const header = events.find(event => event.type === 'request/header')
  expect(header).toBeDefined()
  expect(JSON.parse(json![1]!)).toEqual(header)
  expect(full).toContain('session_event_search')
}

/** Require real resource results and literal instructions before recording or replay succeeds. */
function verifyMcpResources(log: string, ptc: boolean): void {
  const events = parseSessionLog(log)
  const nativeResults = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
  const dispatches = events.flatMap(event => event.type === 'tool/ptc-dispatch' ? [event.data] : [])
  const results = ptc ? dispatches : nativeResults
  expect(results.length).toBeGreaterThanOrEqual(5)
  expect(results.every(result => !result.isError)).toBe(true)
  const calls = ptc ? dispatches.map(dispatch => dispatch.name)
    : events.flatMap(event => event.type === 'tool/call' ? [event.data.name] : [])
  expect(calls).toEqual(expect.arrayContaining(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']))
  const text = results.flatMap(result => result.content
    .flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
  expect(text).toContain('memo://text')
  expect(text).toContain('memo://greeting/{name}')
  expect(text).toContain('MCP resource text with {{braces}} intact.')
  expect(text).toContain('binary resource')
  expect(text).toContain('Hello, reader.')
  if (ptc) {
    const output = nativeResults.flatMap(result => result.content
      .flatMap(block => block.type === 'text' ? [block.text] : [])).join('\n')
    expect(output).toMatch(/"binaryAvailable"\s*:\s*true/)
  }
  expect(log).not.toContain('bWNwLXJlc291cmNlLWJpbmFyeQ==')
  expect(normalizedSystemPrompts(log, contextOf([log])).join('\n'))
    .toContain('MCP_RESOURCE_INSTRUCTION: keep {{braces}} literal.')
  expect(normalizedSystemPrompts(log, contextOf([log])).join('\n'))
    .toContain('server argument: ["catalog"]')
}

function verifyNoMcpServers(log: string, ptc: boolean): void {
  const events = parseSessionLog(log)
  const headers = events.flatMap(event => event.type === 'request/header' ? [event.data.header] : [])
  const prompts = events.flatMap(event => event.type === 'system/message'
    ? event.data.message.content.filter(block => block.type === 'text').map(block => block.text) : [])
  expect(headers.length).toBeGreaterThan(0)
  expect(prompts.length).toBeGreaterThan(0)
  for (const header of headers) {
    const names = header.tools?.map(tool => tool.name) ?? []
    expect(names.filter(name => name.includes('mcp'))).toEqual([])
    if (ptc) expect(names).toEqual(['run_code'])
    else expect(names).toContain('bash')
  }
  for (const prompt of prompts) {
    expect(prompt).not.toMatch(/\bMCP\b|mcp__/)
    expect(prompt).not.toMatch(/list_mcp_resources|list_mcp_resource_templates|read_mcp_resource/)
    if (ptc) expect(prompt).toContain('declare const tools:')
  }
}

/** Require an admitted failed job and zero process allocations before updating its recorded oracle. */
async function verifyBackgroundConfinementFailure(log: string, cwd: string): Promise<void> {
  const results = parseSessionLog(log).flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
  const started = results.find(result => result.toolCallId === 'async-confinement-start')
  const inspected = results.find(result => result.toolCallId === 'async-confinement-result')
  expect(started).toMatchObject({ isError: false, content: [{ type: 'text', text: 'started background job bash-1' }] })
  expect(inspected?.isError).toBe(false)
  const text = inspected?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
  expect(text).toContain('[status: failed,')
  expect(text).toContain('fixture asynchronous confinement refused')
  expect(JSON.parse(await readFile(join(cwd, 'confinement-audit.json'), 'utf8'))).toEqual({ confineCalls: 1, spawnCalls: 0 })
}

/** Exercise provider-cwd adoption through the shipped launcher without normalizing away the observation. */
async function verifyProviderCwdResume(
  scenario: HeadlessScenario,
  cwd: string,
  initial: readonly SessionLog[],
  patches: readonly string[],
  model: { provider: string; model: string },
  fixture: string,
  task: string,
): Promise<void> {
  const providerCwd = scenario.manifest.environment?.DSH_SNAPSHOT_PROVIDER_CWD
  const primary = initial[0]
  expect(providerCwd).toBeDefined()
  expect(primary?.header.cwd).toBe(providerCwd)
  expect(primary?.header.cwd).not.toBe(cwd)
  const otherHostCwd = await mkdtemp(join(tmpdir(), 'dsh-provider-resume-'))
  const env = {
    DSH_HOME: join(cwd, '.dsh'),
    DSH_SNAPSHOT: 'replay',
    DSH_SNAPSHOT_FILE: fixture,
    DSH_SNAPSHOT_PROVIDER: model.provider,
    DSH_SNAPSHOT_MODEL: model.model,
    DSH_PERMISSION_MODE: 'read-only',
    DSH_TELEMETRY_DISABLED: '1',
    NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
  }
  const launch = {
    cwd: otherHostCwd,
    binScript: dshBin,
    configPath: patches[0] as string,
    tsconfigPath,
    binArgs: [
      '--profile', 'headless',
      ...patches.flatMap(file => ['--patch', isAbsolute(file) ? file : join(cwd, file)]),
      '--session-id', String(primary?.header.id), task,
    ],
  }
  try {
    const refused = await runLoaderSmoke({
      ...launch, label: 'provider-cwd mismatched resume', expectedExitCode: 1,
      env: { ...env, DSH_SNAPSHOT_PROVIDER_CWD: `${providerCwd}/other` },
    })
    expect(refused.stdout).toBe('')
    expect(refused.stderr).toContain(`was recorded in "${providerCwd}", not "${providerCwd}/other"`)
    expect(await persistedSessions(cwd)).toEqual(initial)
    const resumed = await runLoaderSmoke({
      ...launch, label: 'provider-cwd matching resume',
      binArgs: [...launch.binArgs.slice(0, -1), '--json', task],
      env: { ...env, DSH_SNAPSHOT_PROVIDER_CWD: providerCwd },
    })
    const output = records(resumed.stdout)
    expect(output[0]).toEqual({ type: 'session', sessionId: primary?.header.id, cwd: providerCwd })
    expect(output.at(-1)).toEqual({ type: 'final', text: finalTextFromSession(primary!.content) })
    const continued = await persistedSessions(cwd)
    expect(continued).toHaveLength(1)
    expect(continued[0]?.header).toEqual(primary?.header)
    expect(continued[0]?.content.startsWith(primary!.content)).toBe(true)
    expect(records(continued[0]!.content).filter(event => event.type === 'turn/start')).toHaveLength(2)
  } finally {
    await rm(otherHostCwd, { recursive: true, force: true })
  }
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
    const headers = normalizedHeaders(log.content, ctx)
    const prompts = normalizedSystemPrompts(log.content, ctx)
    if (headers.length > 0) {
      expect(systemPromptPrecedesRequests(log.content), `${scenario.name}: a system/message precedes the first request/header`).toBe(true)
      expect(prompts.length, `${scenario.name}: system/message count`)
        .toBe(1 + (logIndex === 0 ? pin.manifest.header.promptChanges ?? 0 : 0))
    }
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
  it('gives every composition and header class exactly one current-writer pin', () => {
    for (const scenario of scenarios) {
      expect(ownerOf(scenario), `${scenario.name}: composition owner`).toBeDefined()
      expect(pinOf(scenario).manifest.sessionFormat, `${scenario.name}: current-writer header pin`).toBeUndefined()
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
    const packedDir = join(snapshotsRoot, 'packed-chunks')
    const packed = await readFile(join(packedDir, await primaryFixtureFile(packedDir)), 'utf8')
    const [header, ...rows] = records(packed)
    const packedTypes = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])
    expect([...new Set(rows.filter(row => packedTypes.has(String(row.type))).map(row => row.type))].sort())
      .toStrictEqual(['reasoning-chunks', 'text-chunks', 'tool-call-chunks'])
    const decoder = releasedV0SessionFormatCodec.createDecoder({ ...header, cwd: '/snapshot' }, 'strict')
    const expanded: SessionFormatEvent[] = []
    const output: SessionFormatMigrationContext = {
      emitEvent: event => { expanded.push(event) },
      emitRun: run => { expanded.push(...run.expand()) },
    }
    let seq = 0
    for (const row of rows) {
      if (packedTypes.has(String(row.type))) {
        const data = row.data as JsonObject
        const values = (row.type === 'tool-call-chunks' ? data.args : data.texts) as unknown[]
        decoder.decodeRow({ ...row, seq0: seq, time0: 0 }, output)
        seq += values.length
      } else {
        decoder.decodeRow({ ...row, seq: seq++, time: 0 }, output)
      }
    }
    decoder.finish(output)
    const unpacked = [header, ...expanded.map(({ seq: _seq, time: _time, ...event }) => event)]
      .map(row => JSON.stringify(row)).join('\n') + '\n'
    const context = contextOf([packed])
    expect(normalizeSessionSnapshots([packed], context)).toEqual(normalizeSessionSnapshots([unpacked], context))
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

  it.each([10, 20])('assigns sibling roles by catalog order when the first child timestamp is %i', async (firstCreatedAt) => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-headless-catalog-order-'))
    try {
      const logs = [
        [
          { type: 'session', version: SESSION_FORMAT_VERSION, id: 'parent', createdAt: 1 },
          { type: 'subagent/catalog', data: { childId: 'child-z' } },
          { type: 'subagent/catalog', data: { childId: 'child-a' } },
        ],
        [{ type: 'session', version: SESSION_FORMAT_VERSION, id: 'child-z', createdAt: firstCreatedAt, parentSession: 'parent' }],
        [{ type: 'session', version: SESSION_FORMAT_VERSION, id: 'child-a', createdAt: 10, parentSession: 'parent' }],
      ].map(rows => rows.map(row => JSON.stringify(row)).join('\n') + '\n')
      for (const content of logs) {
        const directory = join(cwd, '.dsh', 'sessions', String(headerOf(content).id))
        await mkdir(directory, { recursive: true })
        await writeFile(join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`), content)
      }
      const actual = await persistedSessions(cwd)
      expect(actual.map(log => log.header.id)).toEqual(['parent', 'child-z', 'child-a'])
      expect(actual.map(log => log.content)).toEqual(logs)
    } finally {
      await rm(cwd, { recursive: true, force: true })
    }
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
        type: 'session', version: SESSION_FORMAT_VERSION, id: 'sidecar-session', createdAt: 1,
        cwd: '/tmp/sidecar-session', isSeeded: false, delegationDepth: 0,
      }
      const content = [
        header,
        { type: 'turn/start', seq: 0, time: 2, data: { turn: 1 } },
        { type: 'step/start', seq: 1, time: 2, data: { turn: 1, step: 1 } },
        { type: 'system/message', seq: 2, time: 3, data: {
          turn: 1, step: 1,
          message: { role: 'system', content: [{ type: 'text', text: 'fresh system prompt' }],
            source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' }, id: 'fresh-msg' },
        }, surfaceOp: 'append' },
        {
          type: 'request/header',
          seq: 3,
          time: 4,
          data: {
            header: {
              config: { provider: 'test', model: 'test' },
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
      expect(sessionFixtureNames(await readdir(directory))).toEqual(['session.v1.jsonl'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('session-reference-spill validates captured generations before adapting its fresh source expectation', async () => {
    const fixture = await readFile(join(snapshotsRoot, 'session-reference-spill/session.v3.jsonl'), 'utf8')
    const recordedVersion = sessionHeaderVersion(fixture, 'session-reference-spill fixture')
    expect(recordedVersion).toBe(3)
    const normalized = normalizeSessionSnapshots([fixture], contextOf([fixture]))[0]!
    const actual = records(normalized)
    spillReferenceSource(actual, 'fresh source').capturedFormatVersion = SESSION_FORMAT_VERSION

    expect(sessionReferenceSpillExpected(actual, normalized, recordedVersion)).toEqual(actual)
    expect(() => sessionReferenceSpillExpected(records(normalized), normalized, recordedVersion))
      .toThrow('fresh reference-source generation')
    expect(() => sessionReferenceSpillExpected(actual, normalized, SESSION_FORMAT_VERSION))
      .toThrow('recorded reference-source generation')
    expect(spillReferenceSource(records(normalized), 'unchanged fixture').capturedFormatVersion).toBe(3)
    expect(await readFile(join(snapshotsRoot, 'session-reference-spill/session.v3.jsonl'), 'utf8')).toBe(fixture)
  })

  it('rejects a native writer that still emits the recorded tool-result wrapper', async () => {
    const fixture = await readFile(join(snapshotsRoot, 'tool-call-turn/session.v3.jsonl'), 'utf8')
    const unconverted = records(fixture)
    unconverted[0]!.version = SESSION_FORMAT_VERSION
    expect(() => verifyToolResultWriterParity(fixture, unconverted.map(row => JSON.stringify(row)).join('\n')))
      .toThrow('native tool-result messages match migration output')
  })

  const runs = scenarios.flatMap((scenario): { scenario: HeadlessScenario; retainedToolInput?: string }[] => [
    { scenario },
    // This comparison retains its own V3 input even after the ordinary scenario records a newer generation.
    ...mode === 'replay' && scenario.name === 'tool-call-turn'
      ? [{ scenario, retainedToolInput: 'session.v3.jsonl' }] : [],
  ])
  for (const { scenario, retainedToolInput } of runs) {
    const skipped = scenario.manifest.platform === 'posix' && process.platform === 'win32'
      || scenario.manifest.platform === 'pwsh' && !hasPwsh
      || mode === 'record' && scenario.manifest.recording === 'authored'
      || mode === 'record' && scenario.manifest.sessionFormat !== undefined
    const scenarioTest = skipped ? it.skip : mode === 'replay' ? it.concurrent : it
    const inputLabel = retainedToolInput === undefined ? '' : ' from retained V3 input'
    scenarioTest(`${mode}s ${scenario.name}${inputLabel} through dsh --profile headless`, async () => {
      let fixtureFiles = retainedToolInput === undefined
        ? sessionFixtureNames(await readdir(scenario.dir)) : [retainedToolInput]
      let fixtures = await fixtureSessions(scenario, fixtureFiles)
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
      const spillRoot = await mkdtemp(join(tmpdir(), 'acp-snap-spill-'))
      const locatorRoot = snapshotSpillRoot(join(scenario.dir, fixtureFiles[0] as string))
      const mcpDemo = scenario.name === 'plugin-manager-mcp' ? await startHttpMcpFixture() : undefined
      let result: Awaited<ReturnType<typeof runLoaderSmoke>>
      try {
        result = await runLoaderSmoke({
          label: `${scenario.name} headless snapshot`,
          tempDirPrefix: 'dsh-log-snap-',
          ...(scenario.manifest.workspace?.parent === 'outside-temp' ? { tempDirParent: outsideTempWorkspaceParent() } : {}),
          binScript: dshBin,
          sourceImport: 'tsx/esm',
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
            DSH_SNAPSHOT_SPILL_LOCATOR_ROOT: locatorRoot,
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
            ...(scenario.name === 'mcp-resources' || scenario.name === 'mcp-resources-ptc' ? {
              DSH_MCP_RESOURCES_FIXTURE: join(repoRoot, 'packages/mcp/mcp-client/tests/fixtures/resources-server.ts'),
            } : {}),
            NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
            DSH_TELEMETRY_DISABLED: '1',
            ...(mcpDemo === undefined ? {} : { DSH_MCP_DEMO_URL: mcpDemo.url }),
          },
          prepare: async (cwd) => {
            if (scenario.manifest.workspace?.parent === 'outside-temp') assertWorkspaceOutsideTemp(cwd)
            await mkdir(join(cwd, patchRoot), { recursive: true })
            patchSources.forEach((source, index) => {
              if (source.endsWith('.snapshot.yml')) {
                materializeProfilePatch(source, cwd, 'headless', join(cwd, patchRoot), index)
              }
            })
            if (mcpDemo !== undefined) {
              const profileDir = join(cwd, '.dsh/profiles/headless')
              await mkdir(profileDir, { recursive: true })
              await copyFile(join(scenario.dir, 'profile.patch.yml'), join(profileDir, 'cordis.patch.yml'))
            }
            await seedWorkspace(scenario, cwd)
            initialWorkspace = await captureWorkspaceSnapshot(cwd, {
              ignoredRootEntries: RUNTIME_WORKSPACE_ENTRIES,
            })
          },
          inspect: async (cwd) => {
            actualLogs = await persistedSessions(cwd)
            if (retainedToolInput !== undefined) {
              verifyToolResultWriterParity(primaryFixture, actualLogs[0]!.content)
            }
            if (mcpDemo !== undefined) {
              const log = actualLogs[0]!.content
              expect(log).toContain('mcp__demo__ping')
              expect(log).toContain('pong')
              expect(mcpDemo.calls).toEqual(['ping'])
              const saved = await readFile(join(cwd, '.dsh/profiles/headless/cordis.patch.yml'), 'utf8')
              expect(saved).toContain('id: demo')
              expect(saved).toContain('disabled: false')
            }
            if (scenario.name === 'session-query-spill') {
              await verifySessionQuerySpill(actualLogs[0]!.content, spillRoot, locatorRoot)
            }
            if (scenario.name === 'mcp-resources' || scenario.name === 'mcp-resources-ptc') {
              verifyMcpResources(actualLogs[0]!.content, scenario.name === 'mcp-resources-ptc')
            }
            if (scenario.name === 'mcp-empty' || scenario.name === 'mcp-empty-ptc') {
              verifyNoMcpServers(actualLogs[0]!.content, scenario.name === 'mcp-empty-ptc')
            }
            if (scenario.name === 'provider-cwd') {
              await verifyProviderCwdResume(
                scenario, cwd, actualLogs, patches, model, join(scenario.dir, fixtureFiles[0] as string), task,
              )
            }
            if (scenario.name === 'background-confinement-failure') {
              await verifyBackgroundConfinementFailure(actualLogs[0]!.content, cwd)
            }
            finalWorkspace = await captureWorkspaceSnapshot(cwd, {
              ignoredRootEntries: RUNTIME_WORKSPACE_ENTRIES,
            })
          },
        })
      } finally {
        await mcpDemo?.close()
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
      const writerFiles = (await readdir(scenario.dir)).filter(name => /^writer(?:\.[1-9]\d*)?\.expected\.jsonl$/u.test(name)).sort()
      if (mode === 'replay') {
        expect(writerFiles, 'native writer oracle inventory').toEqual(scenario.manifest.sessionFormat === undefined
          ? [] : fixtures.map((_, index) => writerSnapshotName(index)).sort())
      }
      let expected = fixtures
      if (scenario.manifest.sessionFormat !== undefined) {
        if (mode === 'refresh') await writeSessionFixtures(scenario, actualLogs, fixtures, actualContext)
        expected = await Promise.all(fixtures.map((_, index) => readFile(join(scenario.dir, writerSnapshotName(index)), 'utf8')))
        for (const [index, content] of expected.entries()) {
          expect(sessionHeaderVersion(content, writerSnapshotName(index))).toBeLessThanOrEqual(SESSION_FORMAT_VERSION)
        }
        expect(await fixtureSessions(scenario), 'historical replay input remains unchanged').toEqual(fixtures)
      }
      const actualSnapshots = normalizeSessionSnapshots(actualLogs.map(log => log.content), actualContext, { nativeWriterOutput: true })
      const expectedSnapshots = normalizeSessionSnapshots(expected, contextOf(expected), { nativeWriterOutput: true })
      for (const [index, actual] of actualSnapshots.entries()) {
        const actualRecords = records(actual)
        const expectedRecords = scenario.name === 'session-reference-spill' && index === 0
          ? sessionReferenceSpillExpected(
            actualRecords,
            expectedSnapshots[index] as string,
            sessionHeaderVersion(expected[index] as string, 'session-reference-spill fixture'),
          )
          : records(expectedSnapshots[index] as string)
        expect(actualRecords, `${scenario.name}: session ${index}`).toEqual(expectedRecords)
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
    }, scenario.name === 'provider-cwd' ? 3 * LOADER_SMOKE_TEST_TIMEOUT_MS : LOADER_SMOKE_TEST_TIMEOUT_MS)
  }
})
