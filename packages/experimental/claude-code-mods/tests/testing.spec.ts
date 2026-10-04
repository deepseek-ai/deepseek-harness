import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { defineMod } from '../src/define-mod.ts'
import type { ModPlugin } from '../src/define-mod.ts'
import { createModTestKit, mock } from '../src/testing.ts'
import type { ModRegister, ModsApi } from '../src/types.ts'

let loads = 0

/** The tutorial mod, its module evaluated afresh so its module-level counter starts at zero, as a Claude Code reload does. */
async function firstMod(): Promise<ModPlugin> {
  loads += 1
  const namespace = await import(`${pathToFileURL(resolve(import.meta.dirname, 'fixtures/first-mod.mjs')).href}?load=${loads}`) as { register: ModRegister }
  return defineMod({ name: 'first-mod', version: '0.1.0', userConfig: { greeting: 'Claude has made' }, register: namespace.register })
}

describe('createModTestKit: the tutorial mod', () => {
  it('/tally reports the tool calls the mod has seen (the test from Claude Code\'s "Test a mod" page)', async () => {
    const kit = await createModTestKit({ mods: [await firstMod()] })
    try {
      // Answer each tool call in Claude Code's place, so no tool runs
      kit.on('tool.call', () => ({ result: 'ok' }))

      // Raise two tool calls, which the mod's tool.call hook counts
      await kit.$.tool.call({ tool: 'Bash', command: 'ls' })
      await kit.$.tool.call({ tool: 'Read', file_path: 'README.md' })

      // Run /tally and check the text its hook returns
      const answer = await kit.$.command.run({ command: 'tally', args: '' })
      expect(answer.text).toBe('Claude has made 2 tool calls since this mod loaded')
      expect(kit.mods.map(mod => mod.name)).toEqual(['first-mod'])
      expect(kit.reports).toEqual([])
    } finally {
      await kit.dispose()
    }
  })

  it('passes configured options to register and answers session.start by default', async () => {
    const kit = await createModTestKit({ mods: [await firstMod()], options: { 'first-mod': { greeting: 'The model made' } } })
    try {
      const registered: unknown[] = []
      kit.on('command.register', (_$, e) => {
        registered.push(e)
        return { value: undefined }
      })
      expect(await kit.$.session.start({ cwd: '/work', surface: null, isInteractive: true })).toEqual({ cwd: '/work' })
      expect(registered).toEqual([{ name: 'tally', description: 'Show how many tool calls Claude has made' }])
      expect((await kit.$.command.run({ command: 'tally', args: '' })).text).toBe('The model made 0 tool calls since this mod loaded')
      expect(await kit.$.command.run({ command: 'other', args: '' })).toEqual({})
    } finally {
      await kit.dispose()
    }
  })
})

describe('createModTestKit: stubs, defaults, and inline mods', () => {
  it('keeps $.state for the test, reports a fire-and-forget call nobody answers, and hands out element constructors', async () => {
    const kit = await createModTestKit({ mods: [{
      name: 'stateful',
      register(on) {
        on('turn.start', async ($, e, next) => {
          const { value = 0 } = await $.state.get({ plugin: 'stateful', key: 'turns' }) as { value?: number }
          await $.state.set({ plugin: 'stateful', key: 'turns' }, value + 1)
          $.ui.toast(`turn ${value + 1}`, { timeoutMs: 10 })
          const { Text } = $.ui.resolve({ component: 'AbovePrompt', surface: 'AbovePrompt', props: {}, viewport: { columns: 80 } })
          const resolved = Text({ children: 'hi' }).type
          return { ...await next(e), turns: value + 1, resolved }
        })
      },
    }] })
    try {
      expect(await kit.$.turn.start({ turnId: '1', text: 'a' })).toEqual({ turnId: '1', turns: 1, resolved: 'Text' })
      expect(await kit.$.turn.start({ turnId: '2', text: 'b' })).toMatchObject({ turns: 2 })
      await new Promise(resolve => setTimeout(resolve, 0))
      expect(kit.reports).toEqual(['stateful: $.ui.toast failed: no implementation for ui.toast', 'stateful: $.ui.toast failed: no implementation for ui.toast'])
    } finally {
      await kit.dispose()
    }
  })

  it('requires a stub for tool.call and reports a mods API call nobody answers', async () => {
    const kit = await createModTestKit({ mods: [{
      name: 'reader',
      register(on) {
        on('tool.call', async ($, e, next) => {
          await $.store.set('last', (e as { tool: string }).tool)
          return next(e)
        })
      },
    }] })
    try {
      await expect(kit.$.tool.call({ tool: 'Bash', command: 'ls' })).rejects.toThrow('no implementation for tool.call')
      expect(kit.reports).toEqual(['reader: tool.call hook skipped: threw Error: no implementation for store.set'])
    } finally {
      await kit.dispose()
    }
  })

  it('answers mods API calls from stubs returning { value } or { deny }, and the kit answers ui.invalidate itself', async () => {
    const kit = await createModTestKit({ mods: [{
      name: 'grader',
      register(on) {
        on('command.run', { command: 'grade' }, async ($, e) => {
          $.ui.invalidate('ui.render')
          const reply = await $.fs.read((e as { args: string }).args)
            .then(text => ({ ok: true, text }), (error: unknown) => ({ ok: false, text: (error as Error).message }))
          return { text: reply.ok ? 'Passed: ' + reply.text : 'Try again: ' + reply.text }
        })
      },
    }] })
    try {
      kit.on('fs.read', (_$, e: { path: string }) => ({ value: e.path.endsWith('grade.txt') ? 'PASS' : '' }))
      expect((await kit.$.command.run({ command: 'grade', args: 'grade.txt' })).text).toBe('Passed: PASS')
      kit.on('fs.read', () => ({ deny: 'no files in tests' }))
      expect((await kit.$.command.run({ command: 'grade', args: 'x' })).text).toBe('Try again: fs.read refused: no files in tests')
      kit.on('fs.read', () => 'bare value')
      expect((await kit.$.command.run({ command: 'grade', args: 'x' })).text).toMatch(/returned neither \{ value \} nor \{ deny \}/)
      kit.on('fs.read', () => ({ nothing: true }))
      expect((await kit.$.command.run({ command: 'grade', args: 'x' })).text).toMatch(/returned neither \{ value \} nor \{ deny \}/)
    } finally {
      await kit.dispose()
    }
  })

  it('mock.store and mock.env answer whole namespaces from memory', async () => {
    const kit = await createModTestKit({ mods: [{
      name: 'notes',
      options: { prefix: 'note:' },
      async register(on, options) {
        on('session.start', async ($, e, next) => {
          const saved = await $.store.get('count')
          await $.store.set('count', (typeof saved === 'number' ? saved : 0) + 1)
          await $.store.set('prefix', options.prefix)
          await $.store.delete('stale')
          await $.env.set('NOTES_HOME', await $.env.get('HOME_DIR') ?? 'unset')
          await $.env.set('GONE', undefined)
          return { ...await next(e), keys: await $.store.keys() }
        })
      },
    }] })
    try {
      const on = kit.on.bind(kit)
      const saved = mock.store(on, { count: 7, stale: true })
      const env = mock.env(on, { HOME_DIR: '/home/me', GONE: 'yes' })
      const result = await kit.$.session.start({ cwd: '/work', surface: null, isInteractive: false })
      expect(result).toEqual({ cwd: '/work', keys: ['count', 'prefix'] })
      expect(saved.get('count')).toBe(8)
      expect(saved.get('prefix')).toBe('note:')
      expect(env).toEqual({ HOME_DIR: '/home/me', NOTES_HOME: '/home/me', GONE: undefined })
    } finally {
      await kit.dispose()
    }
  })

  it('raises the other bridged events with their default answers and lets a stub replace them', async () => {
    const seen: string[] = []
    const kit = await createModTestKit({ mods: [{
      name: 'observer',
      register(on) {
        on('*', (_$: ModsApi, e, next) => {
          const fields = e as { turnId?: string; text?: string; sessionId?: string }
          seen.push(String(fields.turnId ?? fields.text ?? fields.sessionId))
          return next(e)
        })
      },
    }] })
    try {
      expect(await kit.$.turn.start({ turnId: '1', text: 'go' })).toEqual({ turnId: '1' })
      expect(await kit.$.turn.complete({ turnId: '1', answer: 'done', durationMs: 5, isAborted: false, reason: 'answer' })).toEqual({ text: '' })
      expect(await kit.$.prompt.submit({ text: 'hello', context: ['extra'] })).toEqual({ text: 'hello', context: ['extra'] })
      expect(await kit.$.prompt.submit({ text: 'plain' })).toEqual({ text: 'plain' })
      expect(await kit.$.session.end({ reason: 'other', sessionId: 's1' })).toEqual({ sessionId: 's1' })
      await expect(kit.raise('agent.spawn', { prompt: 'x' })).rejects.toThrow('no implementation for agent.spawn')
      kit.on('turn.complete', () => ({ text: 'from stub' }))
      expect(await kit.$.turn.complete({ turnId: '2', answer: '', durationMs: 0, isAborted: true, reason: 'aborted' })).toEqual({ text: 'from stub' })
      kit.on('turn.complete', () => undefined)
      await expect(kit.$.turn.complete({ turnId: '3', answer: '', durationMs: 0, isAborted: false, reason: 'answer' })).rejects.toThrow('the stub returned no result')
      expect(seen).toEqual(['1', '1', 'hello', 'plain', 's1', 'undefined', '2', '3'])
    } finally {
      await kit.dispose()
    }
  })
})

describe('createModTestKit: surfaces, clocks, and kit defaults', () => {
  it('mounts a surface that renders on every read, presses buttons, and refuses invalid trees and double mounts', async () => {
    const pressed: string[] = []
    const kit = await createModTestKit({ mods: [{
      name: 'drawer',
      register(on) {
        on('ui.render', { component: 'AbovePrompt' }, async ($, e) => {
          const { Box, Text, Button } = $.ui.resolve(e)
          const { value: count = 0 } = await $.state.get({ plugin: 'drawer', key: 'count' }) as { value?: number }
          if (e.props['broken'] === true) return { type: 'Text', props: {} } as never
          return Box({ children: [Text({ children: `count ${count}` }), Button({ label: 'More', onPress: async () => {
            pressed.push('more')
            await $.state.set({ plugin: 'drawer', key: 'count' }, count + 1)
          } })] })
        })
        on('ui.render', { component: 'Pane' }, async ($, e, next) => {
          const opened = await $.ui.open({ id: 'p', title: 'Pane' })
          await $.ui.close({ id: 'p' })
          return opened.isPlaced ? next(e) : $.ui.resolve(e).Text({ children: `pane ${e.requestId ?? ''} ${e.surface}` })
        })
      },
    }] })
    try {
      const band = await kit.$.ui.mount({ component: 'AbovePrompt', props: { bodyColumns: 100 } })
      expect(await band.text()).toBe('count 0More')
      const [more] = await band.findAll({ type: 'Button' })
      expect(more?.text).toBe('More')
      await more?.press()
      expect(await band.text()).toBe('count 1More')
      await expect((await band.find({ type: 'Text' }))?.press()).rejects.toThrow('press() needs a Button with onPress, not a Text')
      await expect(kit.$.ui.mount({ component: 'AbovePrompt' })).rejects.toThrow('surface AbovePrompt is already mounted')
      await band.unmount()
      const broken = kit.$.ui.mount({ component: 'AbovePrompt', props: { broken: true } })
      await expect(broken).rejects.toThrow(/ui.render returned a tree that does not validate: a tree node is object/)
      // The kit's own defaults answer ui.open (unplaced) and ui.close.
      const pane = await kit.$.ui.mount({ component: 'Pane', requestId: 'p' })
      expect(await pane.text()).toBe('pane p p')
      await pane.unmount()
    } finally {
      await kit.dispose()
    }
  })

  it('loads nothing by default', async () => {
    const kit = await createModTestKit()
    expect(kit.mods).toEqual([])
    await kit.dispose()
  })

  it('mock.clock answers clock.now and clock.sleep from a settable instant', async () => {
    const kit = await createModTestKit({ mods: [{
      name: 'timer',
      register(on) {
        on('turn.start', async ($, e, next) => {
          const before = await $.clock.now()
          await $.clock.sleep(250)
          return { ...await next(e), before, after: await $.clock.now() }
        })
      },
    }] })
    try {
      const clock = mock.clock(kit.on, 1_000)
      expect(await kit.$.turn.start({ turnId: '1' })).toEqual({ turnId: '1', before: 1_000, after: 1_250 })
      clock.advance(50)
      expect(clock.now).toBe(1_300)
    } finally {
      await kit.dispose()
    }
  })
})
