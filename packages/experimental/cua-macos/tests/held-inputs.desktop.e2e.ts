/** Opt-in desktop receiver checks through the real program tools, AgentLoop, and signed helper. */
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import { brandString } from '@deepseek-ai/dsh-brand'
import ComputerUse from '@deepseek-ai/dsh-computer-use'
import { createUserMessage, LlmAdapter, type GenerateOptions, type StreamChunk, type ToolCallId } from '@deepseek-ai/dsh-llm'
import NodeRuntime from '@deepseek-ai/dsh-ptc-runtime-node'
import Sandbox from '@deepseek-ai/dsh-sandbox-local'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId } from '@deepseek-ai/dsh-session'
import Subprocess from '@deepseek-ai/dsh-subprocess-local'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import { expect, it } from 'vitest'
import { z } from 'zod'
import * as Provider from '../src/index.ts'

const run = promisify(execFile)
const helperPath = process.env.DSH_CUA_TEST_HELPER
const State = z.object({
  pid: z.number(), windowId: z.string().nullable(), active: z.boolean(), keyWindow: z.boolean(),
  pad: z.tuple([z.number(), z.number(), z.number(), z.number()]),
  events: z.array(z.object({ type: z.number(), keyCode: z.number().optional(), sourcePid: z.number() })),
})

// These cases share the real desktop and deliberately run in order. Run this opt-in file alone.
it.skipIf(process.platform !== 'darwin' || helperPath === undefined).each(['completed', 'error', 'thinking-stop', 'tool-stop'] as const)(
  'receives mixed releases after %s through cua_run_code', async (ending) => {
    if (helperPath === undefined) throw new Error('Set DSH_CUA_TEST_HELPER to a signed helper application executable')
    const directory = await mkdtemp(join(tmpdir(), 'dsh-turn-input-desktop-'))
    const appDirectory = join(directory, 'Input Receiver.app')
    const executable = join(appDirectory, 'Contents/MacOS/InputReceiver')
    const stateFile = join(directory, 'state.json')
    const ctx = new Context()
    let fixture: ReturnType<typeof spawn> | undefined
    let exited: Promise<unknown> | undefined
    let cursor: number[] | undefined
    try {
      await mkdir(join(appDirectory, 'Contents/MacOS'), { recursive: true })
      await writeFile(join(appDirectory, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>test.dsh.turn-input</string>
<key>CFBundleName</key><string>Input Receiver</string>
<key>CFBundleExecutable</key><string>InputReceiver</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>DSHFixtureBackground</key><true/>
<key>DSHFixtureKeyboard</key><true/>
</dict></plist>`)
      await run('swiftc', [fileURLToPath(new URL('../native/tests/CapabilitiesFixture.swift', import.meta.url)), '-o', executable])
      cursor = z.array(z.number()).parse(JSON.parse((await run(executable, ['--cursor'])).stdout))
      fixture = spawn(executable, [stateFile], { stdio: 'ignore' })
      exited = once(fixture, 'exit')
      const observe = async () => State.parse(JSON.parse(await readFile(stateFile, 'utf8')))
      await expect.poll(async () => {
        try { return (await observe()).windowId }
        catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error }
      }, { timeout: 30_000 }).toBeTruthy()
      const initial = await observe()
      const pad = initial.pad
      const programs = [
        `var app = await cua.getApp(${JSON.stringify(String(initial.pid))}); await app.activate(); var win = await app.getWindow(${JSON.stringify(initial.windowId)}); await win.getAccessibilityTree(); var bounds = (await app.getWindows()).find(w => w.windowId === win.windowId).bounds; await win.mouseMove([Math.round(${pad[0] + 80} / bounds.width * 999), Math.round(${pad[1] + 70} / bounds.height * 999)], { relative: true, useSystemInput: true }); await app.sendKeyEvent('a', 'down')`,
        `await win.toggleMouse('left', 'down', { useSystemInput: true }); await app.sendKeyEvent('w', 'down'); ${ending === 'tool-stop' ? 'await new Promise(() => {})' : ''}`,
      ]
      const thinking: PromiseWithResolvers<void> = Promise.withResolvers()
      class Model extends LlmAdapter {
        private index = 0
        async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          const code = programs[this.index++]
          if (code !== undefined) {
            yield { type: 'block-start', index: 0, blockType: 'tool-call' }
            yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: brandString<ToolCallId>(`input-${this.index}`),
              name: 'cua_run_code', arguments: JSON.stringify({ code, description: 'Exercise the owned desktop input receiver' }) } }
            yield { type: 'finish', reason: { kind: 'tool-calls' } }
            return
          }
          if (ending === 'error') throw new Error('Controlled model failure after input')
          if (ending === 'thinking-stop') {
            thinking.resolve()
            await new Promise<void>((resolve) => { options.signal?.addEventListener('abort', () => { resolve() }, { once: true }) })
          }
          yield { type: 'finish', reason: { kind: 'stop' } }
        }
      }
      await mountAgentLoopTestDependencies(ctx, { workingDirectory: true })
      await ctx.plugin(Subprocess)
      await ctx.plugin(Sandbox)
      await ctx.plugin(SandboxPolicy, { mode: 'danger-full-access' })
      await ctx.plugin(NodeRuntime)
      await ctx.plugin(ComputerUse)
      await ctx.plugin(UserQuestions)
      ctx.on('user-questions/request', async () => ({ answers: [{ id: 'cua-app-access', selected: ['Allow for this session'] }] }))
      await ctx.plugin(Provider, { helperPath, requireSystemInputApproval: false })
      const permissions = await ctx.cuaAccess.systemStatus()
      if (permissions.platform !== 'darwin') throw new Error('Expected macOS permission metadata')
      const sourcePid = permissions.helper.pid
      const received = async () => (await observe()).events.filter(event => event.sourcePid === sourcePid)
      await mountAgentLoopTestHarness(ctx)
      ctx.llm.registerAdapter(['desktop-fixture'], new Model())
      const handle = await ctx.agents.create({ sessionId: brandString<SessionId>(`desktop-${ending}`), meta: { cwd: directory },
        agentOptions: { provider: 'desktop-fixture', model: 'fixture' } })
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Exercise owned input' }], source: { kind: 'user' } }))
      if (ending === 'thinking-stop') { await thinking.promise; handle.agent.cancel({ kind: 'user' }) }
      if (ending === 'tool-stop') {
        await expect.poll(async () => (await received()).length, { timeout: 30_000 }).toBe(3)
        handle.agent.cancel({ kind: 'user' })
      }
      await handle.agent.whenIdle()
      if (ending !== 'tool-stop') {
        const failures = handle.agent.session.deriveMessages().filter(message => message.role === 'tool' && message.isError)
        expect(failures, JSON.stringify(failures)).toEqual([])
      }
      if (ending === 'completed') {
        await expect.poll(async () => (await received()).map(event => event.type), { timeout: 30_000 }).toEqual([10, 1, 10])
        expect(JSON.stringify(handle.agent.session.snapshotEvents())).toContain('CUA inputs are still held')
        programs[3] = "await app.sendKeyEvent('w', 'up'); await win.toggleMouse('left', 'up', { useSystemInput: true }); await app.sendKeyEvent('a', 'up')"
        handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Release held input' }], source: { kind: 'user' } }))
        await handle.agent.whenIdle()
      }
      await expect.poll(async () => (await received()).map(event => [event.type, event.keyCode ?? null]), { timeout: 30_000 }).toEqual([
        [10, 0], [1, null], [10, 13], [11, 13], [2, null], [11, 0],
      ])
      const outcomes = handle.agent.session.snapshotEvents().filter(event => event.type === 'turn/end')
      expect(outcomes).toHaveLength(ending === 'completed' ? 2 : 1)
      expect(outcomes[0]?.data.reason.kind).toBe(ending === 'completed' ? 'completed' : ending === 'error' ? 'error' : 'aborted')
      await handle.dispose()
    } finally {
      try { await ctx.fiber.dispose() } finally {
        if (cursor) await run(executable, ['--cursor', ...cursor.map(String)])
        if (fixture && exited && fixture.exitCode === null && fixture.signalCode === null) {
          fixture.kill('SIGTERM')
          const deadline = setTimeout(() => { fixture?.kill('SIGKILL') }, 5000)
          try { await exited } finally { clearTimeout(deadline) }
        }
        await rm(directory, { recursive: true, force: true })
      }
    }
  },
)
