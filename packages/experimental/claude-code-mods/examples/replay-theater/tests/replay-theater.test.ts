// Replay Theater's test, in the style of the Token Weather test from
// "Getting started with Claude Code mods" (https://claude.dev/blog/getting-started-with-claude-code-mods/).
// The post publishes no test for this mod; this one covers the behavior it describes.
import { describe, expect, test } from 'claude-code/testing'

describe('replay-theater', () => {
  test("records a turn's edits, hints above the prompt, and steps through the diffs from /replay", async ($, on) => {
    const registered: unknown[] = []
    on('command.register', (_$, e) => {
      registered.push(e)
      return { value: undefined }
    })
    on('tool.call', () => ({ result: 'ok' }))
    on('fs.read', (_$, e: { path: string }) => ({ value: e.path === '/work/greet.js' ? 'greet()\nold line\n' : '' }))
    on('ui.open', (_$, e: { id: string }) => ({ value: { id: e.id, isPlaced: true } }))
    on('ui.close', () => ({ value: undefined }))

    await $.session.start({ cwd: '/work' })
    expect(registered).toEqual([{ name: 'replay', description: "Step through the last turn's file edits" }])
    expect(await $.command.run({ command: 'replay', args: '' })).toEqual({ text: 'No edits' })

    await $.turn.start({ turnId: '1', text: 'rename hello to greet' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/greet.js', old_string: 'hello()', new_string: 'greet()' })
    await $.tool.call({ tool: 'Write', file_path: '/work/greet.js', content: 'greet()\nnew line\n' })
    await $.tool.call({ tool: 'Bash', command: 'ls' })
    const band = await $.ui.mount({ component: 'AbovePrompt', props: { bodyColumns: 120 } })
    // Nothing shows until the turn ends: the replay is one turn's edits.
    expect(await band.tree()).toBeNull()
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 })
    expect(await band.find({ type: 'Text', text: /2 edits this turn/ })).toBeDefined()

    // A subagent's turn does not disturb the sealed replay.
    await $.turn.start({ turnId: 'sub', text: '', agentId: 'agent-2' })
    await $.turn.complete({ reason: 'answer', answer: '', durationMs: 1, agentId: 'agent-2' })
    expect(await band.find({ type: 'Text', text: /2 edits this turn/ })).toBeDefined()

    expect(await $.command.run({ command: 'replay', args: '' })).toEqual({ text: 'Replaying' })
    const pane = await $.ui.mount({ component: 'Pane', requestId: 'replay' })
    expect(await pane.find({ type: 'Text', text: /step 1 of 2/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^- hello\(\)$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^\+ greet\(\)$/ })).toBeDefined()
    // The band hands over to the pane while it is open.
    expect(await band.tree()).toBeNull()

    await (await pane.find({ type: 'Button', label: 'Next' }))?.press()
    expect(await pane.find({ type: 'Text', text: /step 2 of 2/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^- old line$/ })).toBeDefined()
    expect(await pane.find({ type: 'Text', text: /^\+ new line$/ })).toBeDefined()
    await (await pane.find({ type: 'Button', label: 'Next' }))?.press()
    expect(await pane.find({ type: 'Text', text: /step 2 of 2/ })).toBeDefined()
    await (await pane.find({ type: 'Button', label: 'Prev' }))?.press()
    expect(await pane.find({ type: 'Text', text: /step 1 of 2/ })).toBeDefined()
    await (await pane.find({ type: 'Button', label: 'Close' }))?.press()
    expect(await pane.tree()).toBeNull()
    expect(await band.find({ type: 'Button', label: 'Replay' })).toBeDefined()

    // The hint's button reopens the replay; a new turn with edits replaces it.
    await (await band.find({ type: 'Button', label: 'Replay' }))?.press()
    expect(await pane.find({ type: 'Text', text: /step 1 of 2/ })).toBeDefined()
    await (await pane.find({ type: 'Button', label: 'Close' }))?.press()
    await $.turn.start({ turnId: '2', text: 'another' })
    await $.tool.call({ tool: 'Edit', file_path: '/work/b.js', old_string: 'a', new_string: 'b' })
    await $.turn.complete({ reason: 'answer', answer: 'done', durationMs: 1 })
    expect(await band.find({ type: 'Text', text: /1 edit this turn/ })).toBeDefined()
    await pane.unmount()
    await band.unmount()
  })
})
