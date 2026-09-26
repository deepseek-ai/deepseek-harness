/**
 * Showcase integration: the real `web_fetch` tool + the real spill stack
 * (`dsh-spill-local` backend + `dsh-spill-policy`), exercised through
 * `ctx.tools.execute()`. Proves the Agent Note's default local-backend path — a large
 * formatted fetch result is automatically retained and spilled with NO
 * tool-specific spill code, and the model-facing text changes ONLY by the
 * deliberate spill notice (the full formatted result lands in the spill file).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { AddressInfo } from 'node:net'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { estimateContent } from '@deepseek-ai/dsh-token-meter/estimate'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

const testToolSignal = new AbortController().signal
import WebRuntime from '@deepseek-ai/dsh-web'
import * as WebFetchLocal from '@deepseek-ai/dsh-web-fetch-http'
import LocalSpillStore from '@deepseek-ai/dsh-spill-local'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'
import * as ToolWeb from '@deepseek-ai/dsh-tool-web'
import { publicHttpNetwork } from '../../web-fetch-http/src/network.ts'

type Handler = (req: IncomingMessage, res: ServerResponse) => void

let server: Server
let base: string
let handler: Handler
let spillRoot: string
let ctx: Context

const BODY = 'X'.repeat(4000) // formatted result is well over the policy cap
const MAX_INLINE_TOKENS = 250 // leaves room for a head/tail preview beside the notice

beforeEach(async () => {
  vi.spyOn(publicHttpNetwork, 'resolve').mockResolvedValue([{ address: '127.0.0.1', family: 4 }])
  handler = (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end(BODY) }
  server = createServer((req, res) => { handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  spillRoot = mkdtempSync(join(tmpdir(), 'dsh-spill-web-'))

  ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(WebRuntime, { fetchProvider: WebFetchLocal.LOCAL_FETCH_PROVIDER_ID })
  // Provider cap generous so the tool returns a large formatted result; the
  // policy cap is what triggers the spill (the Agent Note's separation of concerns).
  await ctx.plugin(WebFetchLocal, { maxBodyChars: 500_000 })
  await ctx.plugin(LocalSpillStore, { root: spillRoot })
  await ctx.plugin(SpillPolicy, { maxInlineTokens: MAX_INLINE_TOKENS })
  await ctx.plugin(ToolWeb)
})

afterEach(async () => {
  vi.restoreAllMocks()
  await ctx.fiber.dispose()
  await new Promise<void>(resolve => server.close(() => { resolve() }))
  rmSync(spillRoot, { recursive: true, force: true })
})

/** A web_fetch call carrying a session owner (so the policy can scope the spill). */
function fetchCall(): Promise<{ isError: boolean; content: { type: string; text?: string }[] }> {
  const agent = { session: { header: { id: SessionId('web-sess') } } }
  const exec = { callId: ToolCallId('call-1'), name: 'web_fetch', arguments: { url: base }, agent, signal: testToolSignal } as unknown as ToolExecution
  return ctx.tools.execute(exec)
}

describe('web_fetch spill showcase', () => {
  it('spills a large formatted result and returns a preview + spill locator', async () => {
    const out = await fetchCall()
    expect(out.isError).toBe(false)
    const text = out.content.map(b => b.text).join('')

    // Model-facing text is a preview + notice within the cap, NOT the full body.
    expect(text.length).toBeLessThan(BODY.length)
    expect(estimateContent([{ type: 'text', text }])).toBeLessThanOrEqual(MAX_INLINE_TOKENS)
    expect(text).toContain(`Fetched ${base}`) // the head of the formatted result survives
    expect(text).toContain('Full formatted result stored at:')
    expect(text).toContain('Use read with offset/limit, or grep this path')

    // The spill file holds the FULL formatted result the tool returned.
    const match = /stored at: (\S+?)\. Use read/.exec(text)
    expect(match).not.toBeNull()
    const spillPath = match![1]!
    const saved = readFileSync(spillPath, 'utf8')
    // The provider cap was generous, so the tool did not truncate: the spill file
    // holds the full formatted result (header + the complete body), far larger
    // than the model-facing preview.
    expect(saved).toContain('(HTTP 200)')
    expect(saved).toContain(BODY)
    expect(saved.length).toBeGreaterThan(text.length)
  })
})
