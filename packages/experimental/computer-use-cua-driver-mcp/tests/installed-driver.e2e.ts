/** Explicit opt-in compatibility check against an installed Cua Driver executable. */
import { isAbsolute } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { expect, it } from 'vitest'
import * as Provider from '../src/index.ts'

const executable = process.env.DSH_COMPUTER_USE_MCP_EXECUTABLE

function driverArguments(): string[] {
  const raw = process.env.DSH_COMPUTER_USE_MCP_ARGS
  if (raw === undefined) return ['mcp']
  const args: unknown = JSON.parse(raw)
  if (!Array.isArray(args) || !args.every((arg: unknown): arg is string => typeof arg === 'string')) {
    throw new Error('DSH_COMPUTER_USE_MCP_ARGS must be a JSON array of strings')
  }
  return args
}

it.skipIf(executable === undefined || executable === '')(
  'discovers installed Cua Driver tools, checks permissions without prompting, and releases ownership',
  { retry: 0 },
  async ({ signal }) => {
    if (executable === undefined || !isAbsolute(executable)) {
      throw new Error('DSH_COMPUTER_USE_MCP_EXECUTABLE must be an absolute executable path')
    }
    const ctx = new Context()
    try {
      await ctx.plugin(ComputerUse)
      await ctx.plugin(SystemPrompt)
      await ctx.plugin(ToolRuntime)
      const provider = await ctx.plugin(Provider, {
        command: executable,
        args: driverArguments(),
        reconnect: { enabled: false },
      })
      expect(ctx.computerUse.providerName).toBe('cua-driver-mcp')
      const schemas = ctx.tools.schemas()
      expect(schemas.length).toBeGreaterThan(0)
      expect(schemas.every(tool => tool.name.startsWith('mcp__cua-driver-mcp__'))).toBe(true)
      const permissions = ctx.tools.get('mcp__cua-driver-mcp__check_permissions')
      expect(permissions).toBeDefined()
      const result = await ctx.tools.execute({
        name: 'mcp__cua-driver-mcp__check_permissions',
        arguments: { prompt: false },
        callId: ToolCallId('installed-driver-permissions'),
        signal,
      })
      expect(result.isError).toBe(false)
      const canonical = result.value
      if (canonical === null || typeof canonical !== 'object' || Array.isArray(canonical)) {
        throw new Error('Cua Driver permission check did not retain its canonical MCP result')
      }
      expect(Array.isArray(canonical.content)).toBe(true)
      expect(canonical.structuredContent).toBeTypeOf('object')
      expect(canonical.structuredContent).not.toBeNull()
      expect(result.content.length).toBeGreaterThan(0)
      expect(result.content.every(block => block.type === 'text')).toBe(true)
      await provider.dispose()
      expect(ctx.tools.schemas()).toEqual([])
      expect(ctx.computerUse.providerName).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  },
)
