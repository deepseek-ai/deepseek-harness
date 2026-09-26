/** Real provider cache usage across registry additions through the built SDK profile. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished } from 'vitest'

const fixturePath = fileURLToPath(new URL('./fixtures/dynamic-tool-cache.mjs', import.meta.url))
const dshBin = fileURLToPath(new URL('../../../lib/bin.js', import.meta.url))
const sampleTool = 'cache_sample'
const sampleLabelGuidance = 'Place each generated sample label on its own line.'
// Provider cache blocks may leave a short uncached suffix of an unchanged request.
const cacheSuffixTokens = 256

interface ObservedRequest {
  stage: 'initial' | 'added' | 'removed'
  turn: number
  step: number
  body: {
    system?: string
    messages: { role: string; content: { type: string; text?: string; tool?: { name: string } }[] }[]
    tools?: { name: string; defer_loading?: true }[]
  }
}

function usageFor(request: ObservedRequest, events: SessionEvent[]): TokenUsage {
  const settled = events.find(event => event.type === 'assistant/message'
    && event.data.turn === request.turn && event.data.step === request.step)
  if (settled?.type !== 'assistant/message' || settled.data.usage === undefined) {
    throw new Error(`Missing provider usage for turn ${request.turn}, step ${request.step}`)
  }
  return settled.data.usage
}

function totalInput(usage: TokenUsage): number {
  return usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('SDK native tool updates with real DeepSeek', () => {
  it.each([false, true])('keeps the preceding conversation cached after a tool addition (prompt update: %s)', { retry: 0 }, async (updatePrompt) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-tool-cache-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const sampleLabel = `CACHE_SAMPLE_${randomUUID()}`
    const evidencePath = join(root, 'requests.jsonl')
    const callsPath = join(root, 'calls.txt')
    const patch = join(root, 'dynamic-tool-cache.patch.yml')
    await writeFile(patch, JSON.stringify([
      { id: 'llm-deepseek', config: {
        apiKeyEnv: 'DEEPSEEK_API_KEY', thinking: 'disabled', maxTokens: 1024,
        retryPolicy: { maxRetries: 0 },
        models: [{ id: 'deepseek-flash', systemPromptUpdate: 'in-history', toolUpdate: 'addition-only' }],
      } },
      { id: 'tools', config: { mode: 'native' } },
      { id: 'session-log-deepseek', disabled: true },
      { id: 'plugin-package-inventory-deepseek', disabled: true },
      { insert: [{ id: 'sdk-dynamic-tool-cache-fixture', name: fixturePath, config: { evidencePath, callsPath, sampleLabel, updatePrompt } }] },
    ]))
    const harness = new DeepSeekHarness({
      dshBin, profile: 'sdk', patches: [patch], dshHome: join(root, 'home'),
      cwd: root, processCwd: root, provider: 'deepseek-official', model: 'deepseek-flash',
      env: { ...process.env, DSH_TELEMETRY_DISABLED: '1', DSH_PERMISSION_MODE: 'danger-full-access' },
      initializeTimeoutMs: 30_000,
    })
    onTestFinished(async () => { await harness.close() })
    await harness.start()
    const session = harness.session()
    const events: SessionEvent[] = []
    const run = async (prompt: string) => {
      const result = await session.run(prompt)
      events.push(...result.events)
      return result.finalResponse
    }
    await run('Do not call tools. Reply READY.')
    // Unique user history makes hits on shared profile instructions insufficient.
    const records = Array.from({ length: 96 }, (_, index) => `record-${index}: ${randomUUID()}`).join('\n')
    await run(`Keep these reference records. Do not call tools. Reply READY.\n${records}`)
    await run('Keep the reference records. Do not call tools. Reply READY.')
    expect(await run(`Use cache_tool_control with action add. After it returns, call ${sampleTool} exactly once and report the generated sample label. This is synthetic example data for this run. Call these separately in order.`)).toContain(sampleLabel)
    expect(await readFile(callsPath, 'utf8')).toBe('add\nsample\n')
    expect(await run('Use cache_tool_control with action remove. After it returns, reply REMOVED and do not call the sample tool.')).toContain('REMOVED')
    expect(await readFile(callsPath, 'utf8')).toBe('add\nsample\nremove\n')

    const requests = (await readFile(evidencePath, 'utf8')).trim().split('\n').map(line => JSON.parse(line) as ObservedRequest)
    expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(0)
    expect(requests).toHaveLength(events.filter(event => event.type === 'assistant/message').length)
    const [initial, history, warm] = requests
    const addedIndex = requests.findIndex(request => request.stage === 'added')
    const before = requests[addedIndex - 1]
    const added = requests[addedIndex]
    const removed = requests.find(request => request.stage === 'removed')
    if (!initial || !history || !warm || !before || !added || !removed) throw new Error('Missing cache transition requests')
    const historyInput = totalInput(usageFor(history, events))
    const precedingInput = totalInput(usageFor(before, events))
    const cached = usageFor(added, events).cacheReadTokens ?? 0
    process.stdout.write(`SDK tool addition cache: ${JSON.stringify({ updatePrompt, historyInput, precedingInput, cached, deficit: precedingInput - cached, removedCached: usageFor(removed, events).cacheReadTokens })}\n`)
    expect(historyInput - totalInput(usageFor(initial, events))).toBeGreaterThan(1024)
    expect(usageFor(warm, events).cacheReadTokens ?? 0).toBeGreaterThanOrEqual(historyInput - cacheSuffixTokens)
    expect(added.turn).toBe(before.turn)
    expect(added.step).toBe(before.step + 1)
    expect(before.body.system).toBe(initial.body.system)
    expect(added.body.system).toBe(initial.body.system)
    expect(added.body.messages.slice(0, before.body.messages.length)).toEqual(before.body.messages)
    expect(added.body.messages.some(message => message.role === 'system'
      && message.content.some(block => block.type === 'text' && block.text?.includes(sampleLabelGuidance)))).toBe(updatePrompt)
    expect(cached, 'the first post-addition request must reuse the preceding conversation input').toBeGreaterThanOrEqual(precedingInput - cacheSuffixTokens)
    expect(initial.body.tools?.map(tool => tool.name)).toEqual(['cache_tool_control'])
    expect(added.body.tools?.slice(0, initial.body.tools?.length)).toEqual(initial.body.tools)
    expect(added.body.tools?.find(tool => tool.name === sampleTool)).toMatchObject({ name: sampleTool, defer_loading: true })
    expect(added.body.messages.flatMap(message => message.content)).toContainEqual({ type: 'tool_addition', tool: { type: 'tool_reference', name: sampleTool } })
    expect(removed.body.tools?.map(tool => tool.name)).toEqual(['cache_tool_control'])
    expect(removed.body.messages.flatMap(message => message.content).some(block => block.type === 'tool_addition')).toBe(false)
    expect(events.filter(event => event.type === 'developer/message').map(event => event.data.message.content)).toEqual([
      [{ type: 'tool-addition', toolName: sampleTool }],
      [{ type: 'tool-removal', toolName: sampleTool }],
    ])
  })
})
