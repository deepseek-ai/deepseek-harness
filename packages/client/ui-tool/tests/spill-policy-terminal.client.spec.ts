/** Producer-to-UI regression for shell results bounded by the real spill policy. */
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { WorkerThreadCodeRuntime } from '@deepseek-ai/dsh-code-runtime-worker-thread'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SpillLocator, SpillStore, type SaveTextSpill, type SpillRef } from '@deepseek-ai/dsh-spill'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import { formatSpillNotice } from '@deepseek-ai/dsh-spill-policy/notice'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import { isSpilledShellCall, terminalCardModel } from '../src/client/tool/models/terminal-card-model.ts'

const spillReference = {
  locator: SpillLocator('/spill/shell.txt'),
  retrievalHint: 'Read the saved text.',
}

class MemorySpillStore extends SpillStore {
  readonly saves: { input: SaveTextSpill; bytes: Buffer }[] = []

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    const bytes = Buffer.from(input.content, 'utf8')
    this.saves.push({ input, bytes })
    return {
      ...spillReference,
      bytes: bytes.length,
    }
  }
}

const shellArgs = { command: 'fixture-output', description: 'Return shell output fixture' }

async function executeShell(text: string, nested: boolean, name = 'bash', maxInlineBytes = 256) {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime, { mode: 'both' })
    await ctx.plugin(MemorySpillStore)
    await ctx.plugin(SpillPolicy, { maxInlineBytes })
    if (nested) await ctx.plugin(WorkerThreadCodeRuntime, {})
    ctx.effect(() => ctx.tools.register(defineContentToolFixture({
      name,
      description: 'Return deterministic shell text without spawning a process.',
      parameters: {
        command: { type: 'string', required: true },
        description: { type: 'string', required: true },
      },
      async execute() { return [{ type: 'text', text }] },
    })))
    const session = Session.create(SessionId('spill-terminal'))
    // The tool pipeline reads only the owner session; no agent loop runs here.
    const agent = { session } as Agent
    const callId = ToolCallId('shell-call')
    const result = await ctx.tools.execute({
      callId,
      agent,
      signal: new AbortController().signal,
      name: nested ? 'run_code' : name,
      arguments: nested ? {
        code: `const blocks = await tools.${name}(${JSON.stringify(shellArgs)}); return blocks[0].text === ${JSON.stringify(text)};`,
        description: 'Dispatch shell fixture through the tool pipeline',
      } : shellArgs,
    })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('shell fixture execution failed')

    let block: ToolResultNode
    if (nested) {
      expect(result.value).toMatchObject({ result: true })
      const dispatches = session.snapshotEvents().filter(event => event.type === 'tool/code-dispatch')
      expect(dispatches).toHaveLength(1)
      const event = dispatches[0]!
      block = {
        kind: 'tool-result', seq: event.seq, time: event.time, callTime: null,
        callId: event.data.subCallId, parentCallId: event.data.parentCallId,
        call: { name: event.data.name, argsRaw: JSON.stringify(event.data.arguments) },
        content: event.data.content, isError: event.data.isError, subCalls: [],
      }
    } else {
      expect(result.value).toEqual([{ type: 'text', text }])
      block = {
        kind: 'tool-result', seq: 1, time: 1, callTime: null, callId,
        call: { name, argsRaw: JSON.stringify(shellArgs) },
        content: result.content, isError: result.isError, subCalls: [],
      }
    }
    expect(block.isError).toBe(false)
    const saves = (ctx.spillStore as MemorySpillStore).saves
    return { block, saves }
  } finally {
    await ctx.fiber.dispose()
  }
}

describe.each([
  { location: 'root', nested: false },
  { location: 'nested', nested: true },
])('$location spill-policy shell terminal fallback', ({ nested }) => {
  describe.each(['bash', 'pwsh'])('%s', (name) => {
    it.each([
      { outcome: 'nonzero exit', marker: '\n[exit code: 7]' },
      { outcome: 'terminating signal', marker: '\n[killed by signal: SIGTERM]' },
      { outcome: 'markerless output', marker: '' },
    ])('keeps a spilled $outcome result generic', async ({ marker }) => {
      const original = 'HEAD 雪\n'.repeat(200) + marker
      const { block, saves } = await executeShell(original, nested, name)
      expect(saves).toHaveLength(1)
      expect(saves[0]!.input).toMatchObject({
        owner: { sessionId: 'spill-terminal' },
        source: { toolName: name, callId: block.callId, label: nested ? 'dispatch' : 'result' },
        content: original,
      })
      expect(saves[0]!.bytes).toEqual(Buffer.from(original, 'utf8'))
      expect(block.content).not.toEqual([{ type: 'text', text: original }])
      expect(block.content).toHaveLength(1)
      const preview = block.content[0]!
      if (preview.type !== 'text') throw new Error('expected a plain-text spill preview')
      expect(Buffer.byteLength(preview.text, 'utf8')).toBeLessThanOrEqual(256)
      expect(preview.text).toContain('HEAD')
      if (marker !== '') expect(preview.text).toContain(marker)
      expect(terminalCardModel(block)).toBeNull()
      expect(isSpilledShellCall(block)).toBe(true)
    })

    it('keeps a notice-only result generic when no preview fits', async () => {
      const original = '雪'.repeat(1_000) + '\n[exit code: 9]'
      const notice = formatSpillNotice({ kind: 'exact', count: Buffer.byteLength(original, 'utf8') }, spillReference)
      const { block, saves } = await executeShell(original, nested, name, Buffer.byteLength(notice, 'utf8'))
      expect(block.content).toEqual([{ type: 'text', text: notice }])
      expect(saves).toHaveLength(1)
      expect(saves[0]!.bytes).toEqual(Buffer.from(original, 'utf8'))
      expect(terminalCardModel(block)).toBeNull()
      expect(isSpilledShellCall(block)).toBe(true)
    })

    it('retains a terminal card when the result fits without spilling', async () => {
      const original = 'short output\n[exit code: 7]'
      const { block, saves } = await executeShell(original, nested, name)
      expect(saves).toHaveLength(0)
      expect(block.content).toEqual([{ type: 'text', text: original }])
      expect(terminalCardModel(block)?.card).toMatchObject({ output: 'short output', exitCode: 7 })
      expect(isSpilledShellCall(block)).toBe(false)
    })
  })
})
