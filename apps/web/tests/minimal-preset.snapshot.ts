import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'
import { ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-system-prompt'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  fixtureUserPrompts,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/minimal-preset', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const UI_EXPECTED = join(SNAPSHOT_DIR, 'ui.expected.md')
const MODE = webSnapshotMode()
const PROMPT = "Use the bash tool to run exactly: printf 'MINIMAL_BASH_CARD_OK\\n'. Then reply exactly MINIMAL_PRESET_REQUEST_OK and stop."

/** Rendered text of the system prompt surface node, or undefined when the surface carries none. */
function systemPromptText(session: Session): string | undefined {
  const message = session.deriveMessages().find(candidate => candidate.role === 'system')
  return message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
}

describe('minimal agent preset', () => {
  let scaffold: WebScaffold
  let agentHandle: AgentHandle
  let disposeInjectedPrompt: () => void
  let browser: Browser | undefined
  let page: Page | undefined
  let tripwire: ReturnType<typeof watchConsole> | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ replayFixture: FIXTURE, compareReplaySession: true, paceMs: 10 })
    disposeInjectedPrompt = scaffold.ctx.systemPrompt.section({
      name: 'test:injected-prompt',
      order: 999,
      text: 'THIS TEXT MUST NOT REACH THE MODEL.',
    })
    agentHandle = await scaffold.ctx.agents.create({
      sessionId: SessionId('minimal-preset-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'minimal' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    agentHandle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: PROMPT }],
      source: { kind: 'user' },
    }))
    await agentHandle.agent.whenIdle()
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await page?.close().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await agentHandle?.dispose().catch((error: unknown) => failures.push(error))
    try {
      disposeInjectedPrompt?.()
    } catch (error: unknown) {
      failures.push(error)
    }
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'minimal preset smoke teardown failed')
  })

  it('sends the exact RL prompt with shell and image schemas, then executes the persistent shell', async () => {
    const requestHeader = agentHandle.agent.session.requestHeader()
    if (requestHeader === undefined) throw new Error('the minimal agent issued no model request')
    const systemPrompt = systemPromptText(agentHandle.agent.session)
    if (systemPrompt === undefined) throw new Error('the minimal agent issued no system prompt')
    const runtimeContexts = agentHandle.agent.session.snapshotEvents().flatMap(event => event.type === 'user/message'
      && event.data.source.kind === 'runtime-context'
      ? [event.data.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')]
      : [])
    expect(runtimeContexts).toEqual([
      `Current runtime context. This snapshot supersedes earlier runtime-context snapshots.\n\nCurrent working directory: ${JSON.stringify(agentHandle.agent.session.header.cwd)}.`,
    ])
    expect(scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'fs')).toBeUndefined()
    expect(scaffold.ctx.agentPresets.serviceFor(agentHandle.agent, 'compaction')).toBeDefined()
    expect(scaffold.ctx.commands.find(agentHandle.agent, 'compact')).toBeDefined()

    const stateDir = join(scaffold.workspaceCwd, 'persistent-state')
    await mkdir(stateDir)
    const signal = new AbortController().signal
    await scaffold.ctx.tools.execute({
      signal,
      callId: ToolCallId('minimal-bash-state-setup'),
      name: 'bash',
      arguments: { command: `cd ${JSON.stringify(stateDir)} && export DSH_MINIMAL_STATE=PERSISTED` },
      agent: agentHandle.agent,
    })
    const bash = await scaffold.ctx.tools.execute({
      signal,
      callId: ToolCallId('minimal-bash-state-read'),
      name: 'bash',
      arguments: { command: 'printf \'%s:%s\n\' "$DSH_MINIMAL_STATE" "$PWD"' },
      agent: agentHandle.agent,
    })
    const text = (result: typeof bash): string => result.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
      .replaceAll(scaffold.workspaceCwd, '{{cwd}}')
      .trimEnd()

    expect({
      prompt: systemPrompt,
      tools: requestHeader.tools?.map(tool => tool.name),
      goalCommand: scaffold.ctx.commands.find(agentHandle.agent, 'goal') !== undefined,
      bash: text(bash),
    }).toMatchInlineSnapshot(`
      {
        "bash": "PERSISTED:{{cwd}}/persistent-state
      [Command finished with exit code 0]",
        "goalCommand": false,
        "prompt": "You are a helpful software engineer assistant.",
        "tools": [
          "bash",
          "read_image",
          "working_directory",
        ],
      }
    `)
    expect(requestHeader.tools?.toSorted((left, right) => left.name.localeCompare(right.name)))
      .toEqual(scaffold.ctx.tools.schemas(agentHandle.agent).toSorted((left, right) => left.name.localeCompare(right.name)))
  })

  it.skipIf(MODE === 'record')('expands the completed persistent Bash call in the Web conversation', async () => {
    onTestFailed(() => { if (page !== undefined) void saveFailureShot(page, 'web-minimal-persistent-bash-card') })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })

    const groupRow = page.locator('[role="treeitem"]').first()
    await groupRow.waitFor({ timeout: 15_000 })
    await groupRow.click()
    const sessionRow = page.locator('[role="treeitem"]').nth(1)
    await sessionRow.waitFor({ timeout: 10_000 })
    await sessionRow.click()
    await page.getByText('MINIMAL_PRESET_REQUEST_OK', { exact: true }).waitFor({ timeout: 15_000 })

    const process = page.locator('[data-turn-process]')
    await process.waitFor({ timeout: 15_000 })
    await expect.poll(() => process.getAttribute('aria-expanded')).toBe('false')
    await process.click()
    await expect.poll(() => process.getAttribute('aria-expanded')).toBe('true')

    const group = page.locator('[data-chat-group-key]').filter({ has: page.locator('[data-sample="bash"]') }).first()
    const groupControl = group.locator('[data-process-activity]')
    await groupControl.waitFor({ timeout: 15_000 })
    await expect.poll(() => groupControl.getAttribute('aria-expanded')).toBe('false')
    const row = group.locator('[data-sample="bash"]').first()
    expect(await row.isVisible()).toBe(false)
    await groupControl.click()
    await expect.poll(() => groupControl.getAttribute('aria-expanded')).toBe('true')
    await row.waitFor({ timeout: 15_000 })
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('false')
    await row.click()

    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    const call = row.locator('xpath=..')
    await call.getByText('IN', { exact: true }).waitFor()
    await call.getByText('OUT', { exact: true }).waitFor()
    await call.getByText('MINIMAL_BASH_CARD_OK\n[Command finished with exit code 0]', { exact: true }).waitFor()
    await call.getByText(/"command": "printf 'MINIMAL_BASH_CARD_OK/).waitFor()

    const snapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(UI_EXPECTED, snapshot, MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, [
      'session.v3.jsonl',
      'system-prompt.expected.md',
      'tool-schemas.expected.json',
      'ui.expected.md',
    ])
  })
})

describe('minimal manual compaction', () => {
  const snapshotDir = fileURLToPath(new URL('../../../snapshots/web/minimal-compact', import.meta.url))
  let scaffold: WebScaffold
  let handle: AgentHandle
  let browser: Browser | undefined
  let page: Page | undefined
  const requests: GenerateOptions[] = []

  beforeAll(async () => {
    const fixture = join(snapshotDir, 'session.v4.jsonl')
    const prompts = fixtureUserPrompts(await readFile(fixture, 'utf8'))
    expect(prompts).toHaveLength(2)
    const [initial, continuation] = prompts
    if (initial === undefined || continuation === undefined) throw new Error('minimal compaction fixture requires two user prompts')
    scaffold = await launchWebScaffold({ replayFixture: fixture, compareReplaySession: true, workspacePathLength: 192 })
    scaffold.ctx.on('llm/stream', async function* (options, next) {
      requests.push(options)
      yield* next()
    })
    handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('minimal-compact-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'minimal' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: initial }], source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
    const session = handle.agent.session
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    const generation = session.surface.replaceGeneration
    const execution = await scaffold.ctx.commands.execute(handle.agent, '/compact', [], new AbortController().signal)
    expect(execution?.result.kind).toBe('success')
    expect(session.surface.replaceGeneration).toBe(generation + 1)
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: continuation }], source: { kind: 'user' },
    }))
    await handle.agent.whenIdle()
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await page?.close().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await handle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'minimal compaction teardown failed')
  })

  it('records the manual command, summary, and durable history replacement', () => {
    const session = handle.agent.session
    const events = session.snapshotEvents()
    const command = events.find(event => event.type === 'command/run')
    const start = events.find(event => event.type === 'compaction/start')
    const summary = events.find(event => event.type === 'compaction/summary')
    const end = events.find(event => event.type === 'compaction/end')
    const done = events.find(event => event.type === 'command/done')
    expect(command?.data.name).toBe('compact')
    expect(start?.data).toMatchObject({ turn: null, sourceCommandId: command?.data.commandId })
    expect(summary?.data).toMatchObject({ sourceCommandId: command?.data.commandId, llmStreamCall: true })
    expect(end?.data).toEqual(start?.data)
    expect(done?.data).toMatchObject({ kind: 'success', sourceEventSeq: summary?.seq })
    const checkpoint = events.find(event => event.type === 'user/message' && event.data.source.kind === 'compact-checkpoint')
    if (checkpoint?.type !== 'user/message') throw new Error('manual compaction produced no checkpoint')
    expect(checkpoint.surfaceOp).toMatchObject({
      op: 'replace', startSeq: summary?.data.shadowedRange.start, endSeq: summary?.data.shadowedRange.end,
    })
    expect(session.deriveMessages().some(message => message.id === checkpoint.data.id)).toBe(true)
    const original = events.find(event => event.type === 'user/message' && event.data.source.kind === 'user')
    if (original?.type !== 'user/message') throw new Error('minimal compaction has no original user message')
    expect(session.deriveMessages().some(message => message.id === original.data.id)).toBe(false)
  })

  it('continues with the summary and the same minimal prompt and tools', () => {
    expect(requests.map(request => request.purpose)).toEqual([undefined, 'compaction', undefined])
    const summary = handle.agent.session.snapshotEvents().find(event => event.type === 'compaction/summary')
    if (summary === undefined) throw new Error('minimal compaction produced no summary')
    const [initial, , continuation] = requests
    if (initial === undefined || continuation === undefined) throw new Error('minimal compaction did not continue')
    expect(continuation.messages.flatMap(message => message.content)).toEqual(expect.arrayContaining(summary.data.summary))
    expect(continuation.messages[0]).toEqual(initial.messages[0])
    expect(continuation.tools).toEqual(initial.tools)
    expect(continuation.messages.flatMap(message => message.content)
      .some(block => block.type === 'text' && block.text === 'MINIMAL_COMPACT_READY')).toBe(true)
    expect(handle.agent.session.deriveMessages().at(-1)?.content)
      .toEqual([{ type: 'text', text: 'MINIMAL_COMPACT_OK' }])
  })

  it.skipIf(MODE === 'record')('renders the manual compaction card and its summary', async () => {
    onTestFailed(() => { if (page !== undefined) void saveFailureShot(page, 'web-minimal-compact') })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('MINIMAL_COMPACT_OK', { exact: true }).waitFor()
    const card = page.getByRole('button', { name: /^compact Compacted / })
    await card.click()
    await expect.poll(() => card.getAttribute('aria-expanded')).toBe('true')
    await compareOrRefreshGolden(join(snapshotDir, 'ui.expected.md'),
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(snapshotDir, [
      'session.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json', 'ui.expected.md',
    ])
  })
})

describe('minimal image reading', () => {
  const snapshotDir = fileURLToPath(new URL('../../../snapshots/web/minimal-read-image', import.meta.url))
  const prompt = 'Use read_image to inspect red.png. Then reply exactly MINIMAL_IMAGE_OK and stop.'
  let scaffold: WebScaffold
  let handle: AgentHandle
  let browser: Browser | undefined
  let page: Page | undefined

  beforeAll(async () => {
    scaffold = await launchWebScaffold({
      replayFixture: join(snapshotDir, 'session.v4.jsonl'), compareReplaySession: true, paceMs: 10,
    })
    await writeFile(join(scaffold.workspaceCwd, 'red.png'), Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64',
    ))
    handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('minimal-image-smoke'),
      meta: { cwd: scaffold.workspaceCwd, agentPreset: 'minimal' },
      agentOptions: { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp' },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'minimal').then(() => undefined),
    })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
  })

  afterAll(async () => {
    const failures: unknown[] = []
    await page?.close().catch((error: unknown) => failures.push(error))
    await browser?.close().catch((error: unknown) => failures.push(error))
    await handle?.dispose().catch((error: unknown) => failures.push(error))
    await scaffold?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'minimal image teardown failed')
  })

  it('logs a durable image with the minimal tool roster', async () => {
    const session = handle.agent.session
    expect(session.requestHeader()?.tools?.map(tool => tool.name)).toEqual(['bash', 'read_image', 'working_directory'])
    const result = session.snapshotEvents().find(event => event.type === 'tool/result')
    expect(result?.data.message.isError).toBe(false)
    expect(result?.data.meta).toEqual({ path: join(scaffold.workspaceCwd, 'red.png') })
    const image = session.deriveMessages().flatMap(message => message.content).find(block => block.type === 'image')
    if (image?.type !== 'image') throw new Error('minimal read_image produced no durable image')
    expect(image.attachment).toMatchObject({ mediaType: 'image/png', width: 1, height: 1, bytes: 69 })
    expect((await scaffold.ctx.attachments.readImage(image.attachment)).data.byteLength).toBe(69)
  })

  it.skipIf(MODE === 'record')('renders the existing image tool card and preview', async () => {
    onTestFailed(() => { if (page !== undefined) void saveFailureShot(page, 'web-minimal-read-image') })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByText('MINIMAL_IMAGE_OK', { exact: true }).waitFor()
    await page.locator('[data-turn-process]').click()
    const group = page.locator('[data-chat-group-key]').first()
    await group.locator('[data-process-activity]').click()
    const card = group.locator('[data-tool="read_image"]').first()
    const row = card.locator('[data-disclosure-row]')
    await row.click()
    await expect.poll(() => row.getAttribute('aria-expanded')).toBe('true')
    const preview = card.locator('img').first()
    await preview.waitFor()
    await expect.poll(() => preview.evaluate(img => img instanceof HTMLImageElement && img.naturalWidth)).toBe(1)
    await compareOrRefreshGolden(join(snapshotDir, 'ui.expected.md'),
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(snapshotDir, [
      'session.v4.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json', 'ui.expected.md',
    ])
  })
})
