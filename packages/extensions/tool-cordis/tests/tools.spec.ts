import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { Context } from '@deepseek-ai/cordis'
import { CordisInspectRegistryService } from '@deepseek-ai/dsh-cordis-host-runner'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import { describe, expect, it } from 'vitest'
import * as CordisInspectTools from '../src/index.ts'

describe('the cordis inspect tools', () => {
  it('declares both read-only tools parallel-safe', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(NativeToolExecutor)
    await ctx.plugin(CordisInspectRegistryService, 10_000)
    await ctx.plugin(CordisInspectTools)
    expect(ctx.tools.get('cordis_inspect_list')?.isConcurrencySafe?.({})).toBe(true)
    expect(ctx.tools.get('cordis_inspect_query')?.isConcurrencySafe?.({ platform: 'host', provider: 'Service', method: 'get' })).toBe(true)
  })
})
