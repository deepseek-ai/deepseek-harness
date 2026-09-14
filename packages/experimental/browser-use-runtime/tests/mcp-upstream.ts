/** Real upstream MCP browser checks against private loopback pages and disposable Chromium. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import type { Plugin } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Llm from '@deepseek-ai/dsh-llm'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Projections from '@deepseek-ai/dsh-session-projection'
import { expect, vi } from 'vitest'
import type { BrowserMcpConfig } from '../src/mcp.ts'

export async function verifyMcpBrowser(
  provider: Pick<Plugin.Object<BrowserMcpConfig>, 'apply'>,
  namespace: string,
  navigate: { name: string; arguments(url: string): Record<string, unknown> },
  mode: 'launch' | 'attach',
): Promise<void> {
  const executable = process.env.DSH_BROWSER_EXECUTABLE!
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-upstream-'))
  const observed = new Set<string>()
  const server = createServer((request, response) => {
    observed.add(request.url!)
    response.writeHead(200, { 'Content-Type': 'text/html' })
    response.end('<!doctype html><title>DSH browser fixture</title><h1>Browser integration works</h1>')
  })
  const ctx = new Context()
  let external: ReturnType<typeof spawn> | undefined
  let exited: Promise<unknown> | undefined
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Fixture has no TCP listener')
    const url = `http://127.0.0.1:${address.port}/${namespace}-${mode}`
    let browserConfig: BrowserMcpConfig = { mode: 'launch', headless: true, executablePath: executable }
    if (mode === 'attach') {
      const profile = join(root, 'external-profile')
      external = spawn(executable, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' })
      exited = once(external, 'exit')
      const portFile = join(profile, 'DevToolsActivePort')
      let port: string | undefined
      await vi.waitFor(async () => { port = (await readFile(portFile, 'utf8')).split('\n')[0]; expect(Number(port)).toBeGreaterThan(0) }, { timeout: 20000 })
      browserConfig = { mode: 'attach', endpoint: `http://127.0.0.1:${port}` }
    }
    const modules = new Map<string, unknown>([
      ['browserUse', BrowserUse], ['prompt', SystemPrompt], ['tools', Tools], ['llm', Llm],
      ['sessions', Sessions], ['agents', Agents], ['loop', AgentLoop], ['projections', Projections], ['browser', provider],
    ])
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, JSON.stringify([...modules.keys()].map(name => ({ id: name, name, config: name === 'loop' ? { agents: [] } : name === 'browser' ? browserConfig : {} }))))
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`Unexpected smoke module ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await ctx.loader.await()
    const owner = await ctx.agents.create({ sessionId: SessionId('browser-upstream'), meta: { cwd: root } })
    await owner.agent.whenIdle()
    await ctx.systemPrompt.assemble({ agent: owner.agent, scope: owner.agent, signal: new AbortController().signal })
    const schemas = ctx.tools.schemas(owner.agent)
    expect(schemas.length).toBeGreaterThan(5)
    expect(schemas.every(tool => tool.name.startsWith(`mcp__${namespace}__`))).toBe(true)
    const result = await ctx.tools.execute({ agent: owner.agent, name: `mcp__${namespace}__${navigate.name}`, arguments: navigate.arguments(url), callId: ToolCallId('navigate'), signal: new AbortController().signal })
    expect(result.isError, JSON.stringify(result.content)).toBe(false)
    expect(observed.has(`/${namespace}-${mode}`)).toBe(true)
    expect(result.content.length).toBeGreaterThan(0)
    await owner.dispose()
    expect(ctx.tools.schemas(owner.agent)).toEqual([])
    if (browserConfig.mode === 'attach') {
      expect(external?.exitCode).toBeNull()
      const response = await fetch(`${browserConfig.endpoint}/json/list`)
      const pages = await response.json() as { url: string }[]
      expect(pages.some(page => page.url === url)).toBe(true)
    }
  } finally {
    await ctx.fiber.dispose()
    if (external !== undefined && external.exitCode === null) external.kill('SIGTERM')
    if (exited !== undefined) await exited
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    })
    await rm(root, { recursive: true, force: true })
  }
}
