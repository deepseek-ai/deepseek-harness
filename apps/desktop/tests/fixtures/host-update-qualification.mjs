/** Built Host qualification; the profile and all session data belong to the caller's private directory. */
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { installDesktopUpdateTaskControl } from '../../../desktop-host/lib/types/update-tasks.js'
import { ready } from './host-update-control.mjs'

const root = process.argv[2]
assert.ok(root)
const project = join(root, 'project')
const require = createRequire(join(project, 'package.json'))
const { LlmAdapter, createUserMessage } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
const observed = []
const { runProfile } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh/profile-boot')).href)
const { loadLayeredEnv, loadProfileDirectory } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-app-boot')).href)
const installAnchor = require.resolve('@deepseek-ai/dsh/package.json')
const running = await runProfile({ environment: loadLayeredEnv('dsh'), profile: 'desktop',
  resolvedProfile: { profile: loadProfileDirectory('dsh', project, installAnchor), installAnchor },
  patchFiles: [], args: ['--no-open', '--port', '0'] })
const host = { updateTasks: installDesktopUpdateTaskControl(running.ctx), dispose: () => running.shutdown.shutdown(0) }
const applicationUrl = running.ctx.connection.authenticatedUrl(`http://127.0.0.1:${running.ctx.webServer.port}`)
const exchange = await fetch(applicationUrl, { redirect: 'manual' })
const cookie = exchange.headers.get('set-cookie')?.split(';', 1)[0]
assert.ok(cookie)
const apiUrl = new URL('/api/qualification', applicationUrl)
try {
  const ctx = await ready.promise
  const entered = Promise.withResolvers()
  class HeldModel extends LlmAdapter {
    nextTool
    toolIssued = false
    async *stream(options) {
      if (this.nextTool !== undefined) {
        const tool = this.nextTool
        this.nextTool = undefined
        this.toolIssued = true
        yield { type: 'block-start', index: 0, blockType: 'tool-call' }
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: `qualification-${tool.name}`,
          name: tool.name, arguments: JSON.stringify(tool.arguments) } }
        yield { type: 'finish', reason: { kind: 'tool-calls' } }
        return
      }
      if (this.toolIssued) {
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
      }
      entered.resolve(options)
      await new Promise(resolve => {
        if (options.signal.aborted) resolve()
        else options.signal.addEventListener('abort', resolve, { once: true })
      })
      yield { type: 'finish', reason: { kind: 'aborted' } }
    }
  }
  const model = new HeldModel()
  ctx.effect(() => ctx.llm.registerAdapter(['update-qualification'], model))
  assert.equal(await host.updateTasks('inspect'), false)
  const owned = await ctx.agents.create({ sessionId: 'desktop-update-qualification', meta: { cwd: root },
    agentOptions: { provider: 'update-qualification', model: 'held' },
    setup: async agentCtx => { await ctx.agentPresets.mount(agentCtx, 'standard') } })
  try {
    const agent = owned.agent
    assert.equal(ctx.agents.get(agent.id), agent)
    assert.equal(await host.updateTasks('inspect'), false)
    for (const createsTask of [false, true]) {
      const entered = Promise.withResolvers()
      const finish = Promise.withResolvers()
      const remove = ctx.connection.fetch.register({ path: '/api/update-qualification', methods: ['POST'], requestBody: 'buffered',
        async fetch() {
          entered.resolve()
          await finish.promise
          if (createsTask) agent.send(createUserMessage({ content: [{ type: 'text', text: 'Admitted write creates queued work' }],
            source: { kind: 'user' } }), 'next-turn', false)
          return new Response('finished')
        } })
      const pending = fetch(new URL('/api/update-qualification', applicationUrl), { method: 'POST', headers: { cookie } })
        .then(async response => ({ status: response.status, body: await response.text() }))
      try {
        await entered.promise
        assert.equal(await host.updateTasks('inspect'), false)
        let drained = false
        const locking = host.updateTasks('lock').then(active => { drained = true; return active })
        assert.equal((await fetch(apiUrl, { headers: { cookie } })).status, 503)
        assert.equal(drained, false)
        finish.resolve()
        assert.equal(await locking, createsTask)
        assert.deepEqual(await pending, { status: 200, body: 'finished' })
        assert.equal(agent.inbox.nextTurn.length, createsTask ? 1 : 0)
        agent.inbox.clear()
        await host.updateTasks('unlock')
        observed.push(createsTask ? 'admitted-write-task-rechecked-after-drain' : 'read-request-drained-without-task-warning')
      } finally { finish.resolve(); await pending; await remove() }
    }
    for (const [target, field] of [['next-turn', 'nextTurn'], ['next-step', 'nextStep']]) {
      agent.send(createUserMessage({ content: [{ type: 'text', text: 'Queued qualification input' }], source: { kind: 'user' } }), target, false)
      assert.equal(agent.status, 'idle')
      assert.equal(agent.inbox[field].length, 1)
      assert.equal(await host.updateTasks('inspect'), true)
      agent.inbox.clear()
      assert.equal(await host.updateTasks('inspect'), false)
      observed.push(target)
    }
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Hold the qualification model request' }], source: { kind: 'user' } }))
    const request = await entered.promise
    assert.equal(agent.status, 'running')
    assert.equal(await host.updateTasks('inspect'), true)
    assert.equal(request.signal.aborted, false)
    assert.equal(await host.updateTasks('lock'), true)
    assert.equal((await fetch(apiUrl, { headers: { cookie } })).status, 503)
    assert.equal(request.signal.aborted, false)
    assert.equal(agent.status, 'running')
    assert.equal(await host.updateTasks('unlock'), true)
    assert.equal((await fetch(apiUrl, { headers: { cookie } })).status, 404)
    agent.cancel({ kind: 'user' })
    await agent.whenIdle()
    assert.equal(request.signal.aborted, true)
    assert.equal(await host.updateTasks('inspect'), false)
    observed.push('running-model', 'admission-lock-preserves-running-work', 'unlock-restores-requests')

    for (const event of ['user-questions/request', 'approval/request']) {
      const asked = Promise.withResolvers()
      // Hold human input before the Remote answerer, which otherwise waits for a connected Client.
      const remove = agent.ctx.on(event, (question, next) => {
        if (question.agent !== agent) return next()
        asked.resolve(question)
        return new Promise((resolve, reject) => {
          const abort = () => event === 'approval/request' ? resolve('cancelled') : reject(question.signal.reason)
          if (question.signal.aborted) abort()
          else question.signal.addEventListener('abort', abort, { once: true })
        })
      }, { prepend: true })
      try {
        model.nextTool = event === 'user-questions/request'
          ? { name: 'ask_user_question', arguments: { questions: [{ id: 'update', question: 'Keep waiting for qualification?' }] } }
          : { name: process.platform === 'win32' ? 'pwsh' : 'bash', arguments: {
            command: process.platform === 'win32' ? "Write-Output 'qualification'" : "printf qualification",
            description: 'Hold a harmless command pending approval',
            sandbox_permissions: 'danger-full-access', justification: 'Qualification holds this approval without running the command',
          } }
        agent.followup(createUserMessage({ content: [{ type: 'text', text: `Exercise ${event}` }], source: { kind: 'user' } }))
        const question = await Promise.race([asked.promise, agent.whenIdle().then(() => {
          throw new Error(`Agent finished without reaching ${event}`)
        })])
        assert.equal(question.signal.aborted, false)
        assert.equal(agent.status, 'running')
        assert.equal(await host.updateTasks('inspect'), true)
        assert.equal(await host.updateTasks('lock'), true)
        assert.equal(question.signal.aborted, false)
        await host.updateTasks('unlock')
        agent.cancel({ kind: 'user' })
        await agent.whenIdle()
        assert.equal(question.signal.aborted, true)
        assert.equal(await host.updateTasks('inspect'), false)
        observed.push(event)
      } finally {
        agent.cancel({ kind: 'user' })
        await agent.whenIdle()
        remove()
      }
    }

    ctx.effect(() => ctx.jobs.attachController('update-qualification'))
    for (const owner of [undefined, agent]) {
      let child
      let done
      const id = ctx.jobs.start({ kind: 'update-qualification', label: 'Private Node process waiting for stdin EOF', owner,
        run() {
          child = spawn(process.execPath, ['-e', "process.stdout.write('ready');process.stdin.resume()"], {
            cwd: root, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          })
          done = new Promise((resolve, reject) => {
            child.once('error', reject)
            child.once('close', (code, signal) => resolve({ code, signal }))
          })
          return { cancel: () => { child.stdin.end() },
            done: done.then(result => ({ status: result.code === 0 && result.signal === null ? 'killed' : 'failed' })) }
        } })
      try {
        await once(child.stdout, 'data', { signal: AbortSignal.timeout(15_000) })
        assert.equal(ctx.jobs.get(id, owner).status, 'running')
        assert.equal(await host.updateTasks('inspect'), true)
        assert.equal(child.exitCode, null)
        assert.equal(ctx.jobs.kill(id, owner, 'Explicit qualification stop'), 'requested')
        assert.equal(ctx.jobs.get(id, owner).status, 'stopping')
        assert.equal(await host.updateTasks('inspect'), true)
        assert.equal((await ctx.jobs.wait(id, 15_000, owner)).status, 'killed')
        assert.deepEqual(await done, { code: 0, signal: null })
        assert.equal(await host.updateTasks('inspect'), false)
        observed.push(owner === undefined ? 'global-node-job' : 'agent-node-job')
      } finally {
        child.stdin.end()
        await done
      }
    }
  } finally { await owned.dispose() }
} finally { await host.dispose() }
await assert.rejects(host.updateTasks('inspect'), /Host is stopping/)
await assert.rejects(host.updateTasks('lock'), /Host is stopping/)
observed.push('disposed-host-refuses-task-inspection')
await writeFile(join(root, 'result.json'), JSON.stringify({ realHost: true, realAgent: true, observed,
  model: 'scripted/held adapter', humanAnswers: 'held answerers', jobs: 'actual Node subprocesses',
  hostDisposed: true, installerExecuted: false }, null, 2) + '\n')
