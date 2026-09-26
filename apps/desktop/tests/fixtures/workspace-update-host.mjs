/** Private, token-authenticated test controls for tasks in the real Desktop Host process. */
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

export const inject = ['agents', 'agentPresets']
export async function apply(ctx) {
  const root = process.env.DSH_WORKSPACE_UPDATE_ROOT
  const token = process.env.DSH_WORKSPACE_UPDATE_TOKEN
  if (!root || !token) throw new Error('Private workspace qualification configuration is missing')
  const require = createRequire(join(process.cwd(), 'package.json'))
  const { createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  let owned
  let holdShutdown = false
  const requests = new Set()
  const requestHistory = []
  ctx.on('connection/request', async (request, _response, next) => {
    const entry = { method: request.method, url: request.url, startedAt: Date.now() }
    requests.add(entry)
    requestHistory.push(entry)
    try { await next() } finally { entry.finishedAt = Date.now(); requests.delete(entry) }
  })
  const server = createServer((request, response) => {
    if (request.method !== 'POST' || request.headers['x-qualification-token'] !== token) { response.writeHead(403).end(); return }
    void (async () => {
      if (request.url === '/queue') {
        owned ??= await ctx.agents.create({ sessionId: `update-confirmation-race-${randomUUID()}`, meta: { cwd: root },
          setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'standard') } })
        owned.agent.send(createUserMessage({ content: [{ type: 'text', text: 'Keep this queued task until explicitly approved' }], source: { kind: 'user' } }), 'next-turn', false)
      } else if (request.url === '/clear') owned?.agent.inbox.clear()
      else if (request.url === '/hold-shutdown') holdShutdown = true
      else if (request.url !== '/status') throw new Error('Unknown qualification operation')
      response.setHeader('Content-Type', 'application/json')
      response.end(JSON.stringify({ queued: owned?.agent.inbox.nextTurn.length ?? 0, holdShutdown,
        requests: [...requests], requestHistory, agents: ctx.agents.list().map(agent => ({ status: agent.status,
          nextTurn: agent.inbox.nextTurn.length, nextStep: agent.inbox.nextStep.length })),
      }))
    })().catch(error => { response.writeHead(500).end(String(error)) })
  })
  ctx.effect(() => async () => {
    server.closeAllConnections()
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    if (holdShutdown) await new Promise(() => {})
    await owned?.dispose()
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  await writeFile(join(root, 'host-control.json'), JSON.stringify({ url: `http://127.0.0.1:${server.address().port}` }))
}
