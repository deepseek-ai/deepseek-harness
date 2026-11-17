/** Opt-in real Windows mouse-button toggles through the native helper. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import { NativeClient } from '@deepseek-ai/dsh-cua/native-client'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { Config } from '../src/index.ts'
import { WindowsNativeRuntime } from '../src/native-runtime.ts'

const helperPath = process.env.DSH_CUA_DESKTOP_TEST_HELPER
const fixturePath = process.env.DSH_CUA_DESKTOP_TEST_FIXTURE
const Counts = z.object({ left: z.number().int(), right: z.number().int(), middle: z.number().int() })
const FixtureState = z.object({
  window: z.string(), foreground: z.string(),
  cursor: z.object({ x: z.number().int(), y: z.number().int() }),
  under: z.string(), buttons: z.string(), clicks: z.number().int(), downs: Counts, ups: Counts,
})
const Initial = z.object({ pid: z.number().int(), state: FixtureState })
const Cover = z.object({ form: FixtureState, sibling: FixtureState })
const App = z.object({ appHandle: z.string(), running: z.boolean() })
const Windows = z.array(z.object({ windowId: z.string(), title: z.string() }))
const ToggleResult = z.object({ dispatched: z.boolean() })

interface Fixture {
  readonly child: ChildProcessWithoutNullStreams
  readonly exit: Promise<Error | undefined>
  read<T>(schema: z.ZodType<T>): Promise<T>
  command<T>(text: string, schema: z.ZodType<T>): Promise<T>
}

function fixtureProcess(path: string): Fixture {
  const child = spawn(path, [], { windowsHide: true })
  child.stderr.pipe(process.stderr)
  const reader = createInterface({ input: child.stdout })
  const iterator = reader[Symbol.asyncIterator]()
  const exit = new Promise<Error | undefined>((resolve) => {
    child.once('error', (error) => { reader.close(); resolve(error) })
    child.once('exit', (code, signal) => {
      reader.close()
      resolve(code === 0 ? undefined : new Error(`Fixture exited with code ${code}, signal ${signal}`))
    })
  })
  const read = async <T>(schema: z.ZodType<T>): Promise<T> => {
    const next = await iterator.next()
    if (next.done) throw new Error('The fixture exited before replying')
    return schema.parse(JSON.parse(next.value))
  }
  return { child, exit, read, command: async (text, schema) => { child.stdin.write(text + '\n'); return read(schema) } }
}

async function releaseAndClose(fixture: Fixture): Promise<void> {
  let forced = false
  const timer = setTimeout(() => { forced = true; fixture.child.kill() }, 5000)
  try {
    if (fixture.child.exitCode === null && fixture.child.signalCode === null && fixture.child.pid !== undefined) {
      // The fixture processes release before close even if an earlier inspection is still awaiting its reply.
      fixture.child.stdin.end('release-input\nclose\n')
    }
    const error = await fixture.exit
    if (forced) throw new Error('Fixture shutdown timed out; mouse-button release could not be confirmed', { cause: error })
    if (error) throw error
  } finally { clearTimeout(timer) }
}

it.skipIf(process.platform !== 'win32' || !helperPath || !fixturePath)(
  'toggles mouse buttons without movement, observation, or implicit release',
  async ({ onTestFinished, signal }) => {
    const fixture = fixtureProcess(fixturePath!)
    const ctx = new Context()
    const cleanups: Array<() => Promise<unknown>> = []
    onTestFinished(async () => {
      const errors: unknown[] = []
      for (const cleanup of [
        () => releaseAndClose(fixture), ...cleanups.toReversed(), () => ctx.fiber.dispose(),
      ]) {
        try { await cleanup() } catch (error) { errors.push(error) }
      }
      if (errors.length > 0) throw new AggregateError(errors, 'Desktop mouse test cleanup failed')
    })
    const inspect = () => fixture.command('inspect', FixtureState)
    const observed = async (expected: object) => {
      let state = await inspect()
      await expect.poll(async () => { state = await inspect(); return state }, { timeout: 5000, interval: 25 }).toMatchObject(expected)
      return state
    }
    const initial = await fixture.read(Initial)
    const focused = await fixture.command('focus', FixtureState)
    expect(focused.window).toBe(initial.state.window)
    expect(focused.foreground, 'Windows denied foreground to the private fixture').toBe(focused.window)
    expect(focused.buttons).toBe('None')

    await ctx.plugin(LocalSubprocessRuntime)
    const nativeRuntime = new WindowsNativeRuntime(ctx, 25, 1000, 'pipe')
    cleanups.push(() => nativeRuntime.dispose())
    const native = new NativeClient(ctx, { ...Config({}), helperPath: helperPath!, cwd: process.cwd() },
      (_owner, config) => nativeRuntime.connect(config))
    cleanups.push(() => native.dispose())
    const app = App.parse(await native.request('getApp', { selector: fixturePath! }, signal))
    expect(app.running).toBe(true)
    const windows = Windows.parse(await native.request('listWindows', { appHandle: app.appHandle }, signal))
    const windowId = initial.state.window
    expect(windows.some(window => window.windowId === windowId)).toBe(true)
    const toggle = async (mouseButton: 'left' | 'right' | 'middle', direction: 'down' | 'up') =>
      ToggleResult.parse(await native.request('toggleMouse', { appHandle: app.appHandle, windowId, mouseButton, direction }, signal))

    const { cursor } = await fixture.command('pointer', FixtureState)
    for (const mouseButton of ['left', 'right', 'middle'] as const) {
      const before = await inspect()
      expect((await toggle(mouseButton, 'down')).dispatched).toBe(true)
      const down = await observed({ cursor, buttons: { left: 'Left', right: 'Right', middle: 'Middle' }[mouseButton],
        downs: { [mouseButton]: before.downs[mouseButton] + 1 }, ups: before.ups })
      await native.request('getCapabilities', {}, signal)
      expect(await inspect()).toMatchObject({ cursor, buttons: down.buttons, ups: down.ups })
      expect((await toggle(mouseButton, 'up')).dispatched).toBe(true)
      await observed({ cursor, buttons: 'None', ups: { [mouseButton]: down.ups[mouseButton] + 1 },
        clicks: down.clicks + (mouseButton === 'left' ? 1 : 0) })
    }

    const sibling = await fixture.command('sibling', FixtureState)
    expect(sibling.foreground).toBe(sibling.window)
    const background = await inspect()
    await expect(toggle('left', 'down')).rejects.toMatchObject({ code: 'FOREGROUND_REQUIRED' })
    expect(await inspect()).toMatchObject({ buttons: 'None', downs: background.downs })
    const restored = await fixture.command('focus', FixtureState)
    expect(restored.foreground).toBe(restored.window)

    const cover = await fixture.command('cover', Cover)
    expect(cover.form.foreground).toBe(cover.form.window)
    expect(cover.form.under).toBe(cover.sibling.window)
    await expect(toggle('left', 'down')).rejects.toMatchObject({ code: 'WINDOW_OBSCURED' })
    expect(await inspect()).toMatchObject({ buttons: 'None', downs: cover.form.downs })
    const uncovered = await fixture.command('uncover', FixtureState)
    expect(uncovered.foreground).toBe(uncovered.window)

    expect((await toggle('left', 'down')).dispatched).toBe(true)
    const pressed = await observed({ buttons: 'Left', downs: { left: uncovered.downs.left + 1 } })
    const outside = await fixture.command('pointer-outside', FixtureState)
    expect(outside.cursor).not.toEqual(pressed.cursor)
    expect(outside.foreground).toBe(outside.window)
    expect(outside.under).not.toBe(outside.window)
    expect((await toggle('left', 'up')).dispatched).toBe(true)
    await observed({ buttons: 'None', cursor: outside.cursor, ups: { left: pressed.ups.left + 1 }, clicks: pressed.clicks })
  }, 120_000)
