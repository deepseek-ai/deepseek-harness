/** Real SDK recovery after a Streamable HTTP server stops accepting the session it issued. */

import { expect, it, onTestFinished } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { executeToolFixture } from '@deepseek-ai/dsh-tool-testkit'
import * as NativeToolRegistry from '@deepseek-ai/dsh-tool-registry-native'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as McpClient from '../src/index.ts'
import { connectionStatusIn } from '../src/status.ts'
import { startHttpMcpFixture } from './http-fixture.ts'

it('sends the call that meets an expired session again after reconnecting', async () => {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolRegistry)
  const fixture = await startHttpMcpFixture({ sessions: true })
  onTestFinished(fixture.close)
  const fiber = await ctx.plugin(McpClient, McpClient.Config({
    transport: 'streamable-http', serverName: 'demo', url: fixture.url,
    failOnStartupError: true, reconnect: { initialDelayMs: 5, maxDelayMs: 40, maxAttempts: 5 },
  }))
  const status = connectionStatusIn(fiber)!
  const states: string[] = []
  status.onChange((value) => { states.push(value.state) })
  const ping = (id: string) => executeToolFixture(ctx, {
    name: 'mcp__demo__ping', arguments: {}, callId: ToolCallId(id), signal: new AbortController().signal,
  })
  expect(await ping('before')).toMatchObject({ isError: false })

  fixture.expireSessions()
  // The server refuses the request before the tool runs, so the tool runs once for this call.
  expect(await ping('expired')).toMatchObject({ isError: false })
  expect(states).toEqual(['reconnecting', 'connecting', 'connected'])
  expect(fixture.calls).toEqual(['ping', 'ping'])

  expect(await ping('after')).toMatchObject({ isError: false })
  expect(states).toEqual(['reconnecting', 'connecting', 'connected'])
})
