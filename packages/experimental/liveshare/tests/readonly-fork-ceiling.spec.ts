/** The ceiling decides per tool use: reads pass, everything that reaches the owner is refused. */

import { describe, expect, it } from 'vitest'
import { forkToolDecision } from '../src/host/fork-ceiling.ts'
import { READ_ONLY_FORK_CEILING } from '../src/host/fork-policy.ts'

const child = 'child-1'
const use = (tool: string, extra: Partial<Parameters<typeof forkToolDecision>[1]> = {}) => ({
  childSessionId: child,
  sessionId: child,
  tool,
  ...extra,
})

describe('read-only fork ceiling', () => {
  it('allows the read tools a bounded workspace read needs', () => {
    // A ceiling that only refuses is not a working fork: these must pass.
    for (const tool of READ_ONLY_FORK_CEILING.allowedTools) {
      expect(forkToolDecision(READ_ONLY_FORK_CEILING, use(tool))).toEqual({ ok: true })
    }
  })

  it('refuses anything that could act on the owner machine or session', () => {
    for (const tool of ['bash', 'write', 'edit', 'settings-write', 'plugin-self-modification', 'subagent']) {
      expect(forkToolDecision(READ_ONLY_FORK_CEILING, use(tool))).toMatchObject({
        ok: false,
        code: 'fork-tool-not-permitted',
      })
    }
  })

  it('refuses another child’s session', () => {
    expect(forkToolDecision(READ_ONLY_FORK_CEILING, { ...use('read'), sessionId: 'other-child' }))
      .toMatchObject({ ok: false, code: 'fork-child-mismatch' })
  })

  it('refuses every use while no ceiling is installed', () => {
    expect(forkToolDecision(undefined, use('read'))).toMatchObject({
      ok: false,
      code: 'fork-ceiling-uninstalled',
    })
  })
})
