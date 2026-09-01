import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Built-artifact smoke for the first generated Remote: plain Node boots the
 * Host and Browser bundle handoffs, then crosses the shared `/api` HTTP route.
 */

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(packageDir, '../../..')
const artifact = (path: string): string => join(root, path)
const artifactUrl = (path: string): string => pathToFileURL(artifact(path)).href

const requiredArtifacts = [
  'packages/client/connection/lib/client.js',
  'packages/client/connection/lib/index.js',
  'packages/api/remotes/lib/client.js',
  'packages/core/agent/lib/index.js',
  'packages/core/session/lib/index.js',
  'packages/goal/goal/lib/index.js',
  'packages/goal/goal/lib/typert.host.js',
  'packages/api/gateway/lib/client.js',
  'packages/api/gateway/lib/index.js',
  'packages/typert/registry/lib/client.js',
  'packages/typert/registry/lib/index.js',
  'packages/session/session-projection/lib/index.js',
].every(path => existsSync(artifact(path)))

describe.skipIf(!requiredArtifacts)('Goal Remote built LIB chain', () => {
  it('runs root and Agent-scoped calls through generated bundles and real HTTP', async () => {
    const urls = Object.fromEntries(Object.entries({
      agent: 'packages/core/agent/lib/index.js',
      apiGatewayClient: 'packages/api/gateway/lib/client.js',
      apiGatewayHost: 'packages/api/gateway/lib/index.js',
      connectionClient: 'packages/client/connection/lib/client.js',
      connectionHost: 'packages/client/connection/lib/index.js',
      goal: 'packages/goal/goal/lib/index.js',
      goalTypert: 'packages/goal/goal/lib/typert.host.js',
      registryClient: 'packages/typert/registry/lib/client.js',
      registryHost: 'packages/typert/registry/lib/index.js',
      remotesClient: 'packages/api/remotes/lib/client.js',
      session: 'packages/core/session/lib/index.js',
      sessionProjections: 'packages/session/session-projection/lib/index.js',
    }).map(([key, path]) => [key, artifactUrl(path)]))
    const script = `
      import { createServer } from 'node:http'
      import * as cordis from '@deepseek-ai/cordis'

      const urls = ${JSON.stringify(urls)}
      const { Context } = cordis
      const { default: AgentRegistry } = await import(urls.agent)
      const connectionHost = await import(urls.connectionHost)
      const { default: TypertRemoteService } = await import(urls.apiGatewayHost)
      const { default: GoalService } = await import(urls.goal)
      const { default: SessionProjectionRegistry } = await import(urls.sessionProjections)
      const { TYPERT } = await import(urls.goalTypert)
      const { default: TypertRegistry } = await import(urls.registryHost)
      const { Session, SessionId } = await import(urls.session)

      const routes = []
      const credentialRecords = new Map()
      const host = new Context()
      host.provide('webServer', {
        register(route) {
          routes.push(route)
          return () => { routes.splice(routes.indexOf(route), 1) }
        },
        tapIndex() { return () => {} },
        port: 0,
      })
      host.provide('credentials', {
        readRecord(key) { return Promise.resolve(credentialRecords.get(key)) },
        async modifyRecord(key, mutate) {
          const current = credentialRecords.get(key)
          const next = await mutate(current)
          if (next !== undefined) credentialRecords.set(key, next)
          return next ?? current
        },
      })
      await host.plugin({ inject: connectionHost.inject, apply: connectionHost.apply })
      await host.plugin(TypertRegistry)
      await host.plugin(AgentRegistry)
      await host.plugin(TypertRemoteService)
      await host.plugin(SessionProjectionRegistry)
      await host.plugin(GoalService)
      host.typert.register(TYPERT)

      const makeAgent = rawId => {
        const session = new Session(SessionId(rawId))
        return {
          id: session.id,
          options: {},
          session,
          ctx: host.extend(),
          status: 'idle',
          acceptsNextStep: false,
          send() {},
          updateInbox() { return 'not-found' },
          followup() {},
          steer() { return { outcome: Promise.resolve({ status: 'rejected' }) } },
          inject(input) { session.append('user/message', input, { surfaceOp: 'append' }) },
          reserveTurnAdmission() {},
          cancel() {},
          whenIdle() { return Promise.resolve() },
        }
      }
      const rootAgent = makeAgent('built-root-agent')
      const scopedAgent = makeAgent('built-scoped-agent')
      host.agents.register(rootAgent)
      host.agents.register(scopedAgent)

      if (routes.length !== 1 || routes[0].path !== '/api') {
        throw new Error('Connection did not register exactly one /api route')
      }
      const server = createServer((request, response) => {
        if ((request.url ?? '/').startsWith('/?')) {
          if (host.connection.authorizeIndex(request, response)) {
            response.writeHead(200, { 'content-type': 'text/html' })
            response.end('<body>shell</body>')
          }
          return
        }
        void routes[0].handler(request, response)
      })
      await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('HTTP server has no TCP address')
      const origin = 'http://127.0.0.1:' + String(address.port)
      const login = await fetch(host.connection.authenticatedUrl(origin), { redirect: 'manual' })
      const setCookie = login.headers.get('set-cookie')
      if (login.status !== 303 || setCookie === null) throw new Error('browser token exchange failed')
      const cookie = setCookie.split(';', 1)[0]
      const hostFetch = globalThis.fetch
      globalThis.fetch = (input, init = {}) => {
        const headers = new Headers(init.headers)
        headers.set('cookie', cookie)
        return hostFetch(input, { ...init, headers })
      }

      const handoffs = new Map()
      globalThis.window = {
        __ModuleLoader__: {
          load(handoff) { handoffs.set(handoff.id, handoff) },
        },
      }
      globalThis.location = { hostname: '127.0.0.1', origin, search: '' }
      await import(urls.registryClient)
      await import(urls.connectionClient)
      await import(urls.apiGatewayClient)
      await import(urls.remotesClient)

      const instantiate = id => {
        const handoff = handoffs.get(id)
        if (handoff === undefined) throw new Error('missing Client bundle handoff ' + id)
        return handoff.factory(specifier => {
          if (specifier === '@deepseek-ai/cordis') return cordis
          throw new Error('unexpected Client external ' + specifier)
        })
      }
      const client = new Context()
      for (const id of [
        '@deepseek-ai/dsh-typert-registry',
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-api-gateway',
        '@deepseek-ai/dsh-api-remotes',
      ]) {
        const plugin = instantiate(id)
        await client.plugin({ inject: plugin.inject, apply: plugin.apply })
      }
      client.typert.contexts.registerClient('agent', {
        identity: candidate => candidate.builtAgentId,
      })

      let invalidRejected = false
      try {
        await client.remote.goals.create(rootAgent.id, { objective: 1 })
      } catch {
        invalidRejected = true
      }
      // Every generated method resolves to the RemoteResult envelope; the
      // business values below are what the assertions pin.
      const rootResult = await client.remote.goals.create(rootAgent.id, { objective: 'root goal' })
      const rootEdit = await client.remote.goals.edit(
        rootAgent.id,
        rootResult.value.ref,
        { objective: 'edited root goal' },
      )
      const agentContext = client.extend({ builtAgentId: scopedAgent.id })
      const scopedResult = await agentContext.remote.goals.create({ objective: 'scoped goal', maxGoalRounds: 3 })
      const result = {
        invalidRejected,
        rootResult: rootResult.value,
        rootEdit: rootEdit.value,
        scopedResult: scopedResult.value,
        rootGoal: host.goals.get(rootAgent)?.objective,
        scopedGoal: host.goals.get(scopedAgent)?.objective,
        rootEvents: rootAgent.session.snapshotEvents().length,
        scopedEvents: scopedAgent.session.snapshotEvents().length,
      }

      await client.fiber.dispose()
      await new Promise((resolveClose, rejectClose) => server.close(error => {
        if (error === undefined) resolveClose()
        else rejectClose(error)
      }))
      await host.fiber.dispose()
      console.log(JSON.stringify(result))
    `

    const result = await runPlainNode(script)
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0)
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      invalidRejected: boolean
      rootResult: { ref: { id: string; revision: number } }
      rootEdit: { objective: string; revision: number }
      scopedResult: { ref: { id: string; revision: number } }
      rootGoal: string
      scopedGoal: string
      rootEvents: number
      scopedEvents: number
    }
    expect(output).toMatchObject({
      invalidRejected: true,
      rootResult: { ref: { revision: 1 } },
      rootEdit: { objective: 'edited root goal', revision: 2 },
      scopedResult: { ref: { revision: 1 } },
      rootGoal: 'edited root goal',
      scopedGoal: 'scoped goal',
      rootEvents: 2,
      scopedEvents: 1,
    })
    expect(output.rootResult.ref.id).toMatch(/^goal-/)
    expect(output.scopedResult.ref.id).toMatch(/^goal-/)
  }, 60_000)
})

/** Execute one ESM script without tsx or a TypeScript loader. */
function runPlainNode(script: string): Promise<{
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 55_000,
    }, (error, stdout, stderr) => {
      resolveRun({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        stdout,
        stderr,
      })
    })
  })
}
