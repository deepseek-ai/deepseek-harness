// Token Weather's test, from "Getting started with Claude Code mods"
// (https://claude.dev/blog/getting-started-with-claude-code-mods/, Anthropic, 2026-10-01).
// Unchanged apart from the three `as any` casts the published file needed, which
// this host's typed test kit does not.
import { describe, expect, test } from 'claude-code/testing'

describe('token-weather', () => {
  test('the band follows the context window', async ($, on) => {
    // Hooks registered here run after the mod and stub what Claude Code would answer.
    let tokens = 36_100
    on('session.start', ($, e) => ({ cwd: e.cwd }))
    on('session.usage', () => ({
      value: { startedAt: 0, rateLimits: [], context: { tokens, window: 200_000, percent: Math.round(tokens / 2_000) } },
    }))
    on('turn.complete', () => ({ text: '' }))

    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    const ui = await $.ui.mount({
      plugin: 'token-weather',
      surface: 'terminal',
      component: 'AbovePrompt',
      props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 },
    })
    expect(await ui.find({ type: 'Text', text: /Clear/ })).toBeDefined()

    tokens = 134_400
    await $.turn.complete({ reason: 'answer', answer: 'ok', durationMs: 1 })
    expect(await ui.find({ type: 'Text', text: /Showers/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /67% of context/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /▲ \+98\.3k last turn/ })).toBeDefined()
    await ui.unmount()
  })
})
