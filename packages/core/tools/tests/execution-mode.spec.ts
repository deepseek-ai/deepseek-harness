/** Covers fail-closed per-call classification and model-schema isolation. */
import { ToolExecutionPipeline } from '@deepseek-ai/dsh-tools/pipeline'

import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { describe, expect, expectTypeOf, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { type ToolDefinition, type ToolExecutionInput, type ToolExecutionMode } from '@deepseek-ai/dsh-tools'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tool-testkit'

const testToolSignal = new AbortController().signal

async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  return ctx
}

function exec(name: string, args: unknown): ToolExecutionInput {
  return { signal: testToolSignal, callId: ToolCallId('c1'), name, arguments: args }
}

describe('ToolExecutionPipeline.executionMode', () => {
  it('returns parallel only for an explicit true classifier', async () => {
    const ctx = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'safe',
      description: 'parallel-safe',
      parameters: {},
      isConcurrencySafe: () => true,
      async execute() { return [] },
    }))
    expect(new ToolExecutionPipeline(ctx).executionMode(exec('safe', {}))).toEqual({ kind: 'parallel' })
  })

  it('defaults to exclusive for a tool with no isConcurrencySafe declaration', async () => {
    const ctx = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'plain',
      description: 'no declaration',
      parameters: {},
      async execute() { return [] },
    }))
    expect(new ToolExecutionPipeline(ctx).executionMode(exec('plain', {}))).toEqual({ kind: 'exclusive' })
  })

  it('returns exclusive for an unknown tool', async () => {
    const ctx = await setup()
    expect(new ToolExecutionPipeline(ctx).executionMode(exec('nonexistent', {}))).toEqual({ kind: 'exclusive' })
  })

  it('returns exclusive when the classifier returns false for these args', async () => {
    const ctx = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'rw',
      description: 'read or write',
      parameters: { mode: { type: 'string', required: true } },
      isConcurrencySafe: args => args.mode === 'read',
      async execute() { return [] },
    }))
    expect(new ToolExecutionPipeline(ctx).executionMode(exec('rw', { mode: 'read' }))).toEqual({ kind: 'parallel' })
    expect(new ToolExecutionPipeline(ctx).executionMode(exec('rw', { mode: 'write' }))).toEqual({ kind: 'exclusive' })
  })

  it('classifies invalid defineContentToolFixture arguments as exclusive without throwing', async () => {
    const ctx = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'needs-mode',
      description: 'requires mode',
      parameters: { mode: { type: 'string', required: true } },
      isConcurrencySafe: () => true,
      async execute() { return [] },
    }))
    expect(new ToolExecutionPipeline(ctx).executionMode(exec('needs-mode', {}))).toEqual({ kind: 'exclusive' })
  })

  it('treats a throwing raw classifier as exclusive', async () => {
    const ctx = await setup()
    const raw: ToolDefinition = {
      name: 'thrower',
      description: 'classifier throws',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'null' }, render: () => [] },
      isConcurrencySafe() { throw new Error('boom') },
      async execute() { return null },
    }
    ctx.tools.register(raw)
    expect(new ToolExecutionPipeline(ctx).executionMode(exec('thrower', {}))).toEqual({ kind: 'exclusive' })
  })

  it('treats a truthy non-boolean raw result as exclusive', async () => {
    const ctx = await setup()
    const raw = {
      name: 'truthy',
      description: 'classifier returns a truthy string',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'null' }, render: () => [] },
      isConcurrencySafe() { return 'yes' },
      async execute() { return null },
    } as unknown as ToolDefinition
    ctx.tools.register(raw)
    expect(new ToolExecutionPipeline(ctx).executionMode(exec('truthy', {}))).toEqual({ kind: 'exclusive' })
  })

  it('passes parsed arguments directly to a raw definition', async () => {
    const ctx = await setup()
    let seen: unknown
    ctx.tools.register({
      name: 'raw-safe',
      description: 'raw',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'null' }, render: () => [] },
      isConcurrencySafe(args) { seen = args; return true },
      async execute() { return null },
    })
    expect(new ToolExecutionPipeline(ctx).executionMode(exec('raw-safe', { anything: 1 }))).toEqual({ kind: 'parallel' })
    expect(seen).toEqual({ anything: 1 })
  })

  it('isConcurrencySafe never reaches the model-facing schemas() projection', async () => {
    const ctx = await setup()
    ctx.tools.register(defineContentToolFixture({
      name: 'safe',
      description: 'parallel-safe',
      parameters: { x: { type: 'string', required: true } },
      isConcurrencySafe: () => true,
      async execute() { return [] },
    }))
    const schema = ctx.tools.schemas()[0] as unknown as Record<string, unknown>
    expect(Object.keys(schema).sort()).toEqual(['description', 'name', 'parameters'])
    expect(schema.isConcurrencySafe).toBeUndefined()
  })

  it('ToolExecutionMode is the object-tagged union', () => {
    expectTypeOf<ToolExecutionMode>().toEqualTypeOf<{ kind: 'parallel' } | { kind: 'exclusive' }>()
  })
})
