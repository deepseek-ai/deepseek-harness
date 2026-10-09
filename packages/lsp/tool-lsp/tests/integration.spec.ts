import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import Lsp from '@deepseek-ai/dsh-lsp'
import * as LspLocal from '@deepseek-ai/dsh-lsp-stdio'
import * as TimeoutPolicy from '@deepseek-ai/dsh-tool-call-timeout-policy'
import * as ToolLsp from '@deepseek-ai/dsh-tool-lsp'

/**
 * Focused in-process integration of the model-facing tool, seam, local provider, and timeout policy.
 * The `lsp-definition` ACP snapshot owns the shipped Loader/app entry path.
 */

let root: string
let ws: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'lsp-tool-int-')))
  ws = join(root, 'ws')
  await mkdir(ws)
  await writeFile(join(ws, 'a.ts'), 'const x = 1\n')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** An inline stdio server that answers initialize + definition; `hang` makes textDocument/* stall. */
function serverScript(hang: boolean): string {
  const definition = JSON.stringify({ uri: pathToFileURL(join(ws, 'a.ts')).href, range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } } })
  return 'let b=Buffer.alloc(0);'
    + `const DEF=${definition};`
    + 'const fr=(o)=>{const x=Buffer.from(JSON.stringify({jsonrpc:"2.0",...o}));return Buffer.concat([Buffer.from(`Content-Length: ${x.length}\\r\\n\\r\\n`),x]);};'
    + 'process.stdin.on("data",c=>{b=Buffer.concat([b,c]);for(;;){const s=b.indexOf("\\r\\n\\r\\n");if(s<0)break;const len=Number(/(\\d+)/.exec(b.toString("ascii",0,s))[1]);if(b.length<s+4+len)break;const m=JSON.parse(b.toString("utf8",s+4,s+4+len));b=b.subarray(s+4+len);'
    + 'if(m.method==="initialize")process.stdout.write(fr({id:m.id,result:{capabilities:{positionEncoding:"utf-16",textDocumentSync:1,definitionProvider:true}}}));'
    + `else if(m.method==="textDocument/definition"){${hang ? '' : 'process.stdout.write(fr({id:m.id,result:DEF}));'}}`
    + 'else if(m.method==="shutdown")process.stdout.write(fr({id:m.id,result:null}));'
    + 'else if(m.method==="exit")process.exit(0);'
    + '}});'
}

async function mount(hang: boolean, timeoutMs?: number): Promise<Context> {
  const ctx = new Context()
  provideWorkingDirectoryFixture(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(Lsp)
  await ctx.plugin(LocalFileSystem, { cwd: process.cwd() })
  await ctx.plugin(LocalSubprocessRuntime)
  await ctx.plugin(LspLocal, {
    servers: {
      inline: {
        command: process.execPath,
        args: ['-e', serverScript(hang)],
        extensionToLanguage: { '.ts': 'typescript' },
        shutdownTimeoutMs: 200,
        killGraceMs: 200,
      },
    },
  })
  await ctx.plugin(TimeoutPolicy)
  await ctx.plugin(ToolLsp, timeoutMs !== undefined ? { timeoutMs } : {})
  return ctx
}

let seq = 0
const testToolSignal = new AbortController().signal
function call(ctx: Context, args: unknown) {
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: `int-${++seq}` as never,
    name: 'lsp',
    arguments: args,
    agent: { session: { header: { cwd: ws } } } as never,
  })
}

describe('tool-lsp integration', () => {
  it('round-trips a definition query through the real provider and renders a location', async () => {
    const ctx = await mount(false)
    const result = await call(ctx, { operation: 'goToDefinition', file_path: 'a.ts', line: 1, character: 7 })
    expect(result.isError).toBe(false)
    expect(result.content[0]).toEqual({ type: 'text', text: 'a.ts:1:1' })
    await ctx.fiber.dispose()
  }, 30_000)

  it('enforces the TOOL_TIMEOUT budget when the server hangs', async () => {
    const ctx = await mount(true, 300)
    const result = await call(ctx, { operation: 'goToDefinition', file_path: 'a.ts', line: 1, character: 7 })
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('TOOL_TIMEOUT')
    await ctx.fiber.dispose()
  }, 30_000)
})
