// Blast Radius's test, in the style of the Token Weather test from
// "Getting started with Claude Code mods" (https://claude.dev/blog/getting-started-with-claude-code-mods/).
// The post publishes no test for this mod; this one covers the behavior it describes.
import { describe, expect, test } from 'claude-code/testing'
import type { MountedElement, MountedSurface } from '../../../src/testing.ts'

/** Poll a mounted surface until a Button with the label shows, as the held hook draws asynchronously. */
async function button(surface: MountedSurface, label: string): Promise<MountedElement> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const found = await surface.find({ type: 'Button', label })
    if (found !== undefined) return found
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  throw new Error(`no ${label} button appeared`)
}

describe('blast-radius', () => {
  test('holds a risky command until Cancel refuses it or Proceed lets it run; safe commands pass', async ($, on) => {
    const ran: string[] = []
    on('session.cwd', () => ({ value: '/work' }))
    on('process.run', (_$, e: { argv: string[] }) => {
      ran.push(e.argv.join(' '))
      // The hold loop waits on short sleeps; give each one real time so a press can land between them.
      if (e.argv[0] === 'sleep' || e.argv[1] === '-e') return new Promise(resolve => setTimeout(() => resolve({ value: { exitCode: 0, stdout: '', stderr: '' } }), 5))
      if (e.argv[0] === 'git' && e.argv[1] === 'status') return { value: { exitCode: 0, stdout: ' M src/index.ts\n M README.md\n', stderr: '' } }
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    })
    on('ui.open', (_$, e: { id: string }) => ({ value: { id: e.id, isPlaced: false } }))
    on('tool.call', (_$, e) => ({ result: `ran ${String(e.command)}` }))

    // Everything else runs as normal.
    expect(await $.tool.call({ tool: 'Bash', command: 'ls -la' })).toEqual({ result: 'ran ls -la' })

    // A risky command is held; without a pane the report is drawn above the prompt.
    const held = $.tool.call({ tool: 'Bash', command: 'git reset --hard' })
    const band = await $.ui.mount({ component: 'AbovePrompt', props: { bodyColumns: 120 } })
    const cancel = await button(band, 'Cancel')
    expect(await band.find({ type: 'Text', text: /Blast Radius: git reset --hard/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /discard uncommitted changes to 2 file\(s\)/ })).toBeDefined()
    expect(await band.find({ type: 'Text', text: /M src\/index\.ts/ })).toBeDefined()
    await cancel.press()
    expect(await held).toEqual({
      deny: 'Blast Radius held this command: the user pressed Cancel. It would have: discard uncommitted changes to 2 file(s).',
    })
    expect(ran).toContain('git status --porcelain')
    // The band yields once the decision is made.
    expect(await band.find({ type: 'Button' })).toBeUndefined()

    // Proceed lets the command run as written.
    const proceeding = $.tool.call({ tool: 'Bash', command: 'git push --force origin main' })
    await (await button(band, 'Proceed')).press()
    expect(await proceeding).toEqual({ result: 'ran git push --force origin main' })
    await band.unmount()
  })

  test('measures a recursive delete with du and find, and draws into a placed pane', async ($, on) => {
    on('session.cwd', () => ({ value: '/work' }))
    on('process.run', (_$, e: { argv: string[] }) => {
      if (e.argv[0] === 'sleep' || e.argv[1] === '-e') return new Promise(resolve => setTimeout(() => resolve({ value: { exitCode: 0, stdout: '', stderr: '' } }), 5))
      if (e.argv[0] === 'du') return { value: { exitCode: 0, stdout: '1.1M\tbuild\n', stderr: '' } }
      if (e.argv[0] === 'find') return { value: { exitCode: 0, stdout: 'build/a.js\nbuild/b.js\nbuild/c.map\n', stderr: '' } }
      return { value: { exitCode: 0, stdout: '', stderr: '' } }
    })
    on('ui.open', (_$, e: { id: string }) => ({ value: { id: e.id, isPlaced: true } }))
    on('tool.call', () => ({ result: 'ran' }))

    const held = $.tool.call({ tool: 'Bash', command: 'rm -rf build' })
    const pane = await $.ui.mount({ component: 'Pane', requestId: 'blast-radius' })
    const cancel = await button(pane, 'Cancel')
    expect(await pane.find({ type: 'Text', text: /delete 3 file\(s\) \(1\.1M\) under build/ })).toBeDefined()
    // With a placed pane the band stays empty.
    const band = await $.ui.mount({ component: 'AbovePrompt', props: { bodyColumns: 120 } })
    expect(await band.tree()).toBeNull()
    await cancel.press()
    expect(await held).toMatchObject({ deny: expect.stringContaining('delete 3 file(s) (1.1M) under build') })
    await pane.unmount()
    await band.unmount()
  })
})
