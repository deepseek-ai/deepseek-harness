import { describe, expect, it } from 'vitest'
import { describeMatcher, eventMatches, isEventPattern, KNOWN_EVENTS, matcherMatches } from '../src/matcher.ts'
import { createToolNameAliases, DEFAULT_TOOL_ALIASES } from '../src/tool-names.ts'

describe('event patterns and matchers', () => {
  it('knows Claude Code\'s event names and globs', () => {
    expect(KNOWN_EVENTS.has('tool.call')).toBe(true)
    expect(isEventPattern('tool.call')).toBe(true)
    expect(isEventPattern('tool.calls')).toBe(false)
    expect(isEventPattern('*')).toBe(true)
    expect(isEventPattern('classic.*')).toBe(false)
    expect(isEventPattern('telemetry.*')).toBe(true)
    expect(isEventPattern('.*')).toBe(false)
  })

  it('matches exact names, namespace globs, and the star without telemetry', () => {
    expect(eventMatches('tool.call', 'tool.call')).toBe(true)
    expect(eventMatches('tool.call', 'tool.check')).toBe(false)
    expect(eventMatches('tool.*', 'tool.check')).toBe(true)
    expect(eventMatches('tool.*', 'turn.start')).toBe(false)
    expect(eventMatches('*', 'turn.start')).toBe(true)
    expect(eventMatches('*', 'telemetry.log')).toBe(false)
    expect(eventMatches('telemetry.*', 'telemetry.log')).toBe(true)
  })

  it('compares scalars by equality, arrays by membership, and regular expressions by test', () => {
    const input = { tool: 'mcp__github__issues', count: 3, flag: true }
    expect(matcherMatches({ tool: 'mcp__github__issues' }, input)).toBe(true)
    expect(matcherMatches({ tool: 'Bash' }, input)).toBe(false)
    expect(matcherMatches({ tool: ['Edit', 'mcp__github__issues'] }, input)).toBe(true)
    expect(matcherMatches({ tool: /^mcp__github__/ }, input)).toBe(true)
    expect(matcherMatches({ count: /^3$/ }, input)).toBe(true)
    expect(matcherMatches({ flag: /true/ }, input)).toBe(false)
    expect(matcherMatches({ tool: 'x', count: 3 }, input)).toBe(false)
    expect(matcherMatches({ tool: 'x' }, 'not an object')).toBe(false)
    expect(matcherMatches({}, input)).toBe(true)
  })

  it('describes matchers the way claude plugin validate prints them', () => {
    expect(describeMatcher(undefined)).toBe('')
    expect(describeMatcher({ component: 'Spinner' })).toBe('{component=Spinner}')
    expect(describeMatcher({ tool: ['Edit', 'Write'], id: /^T-/ })).toBe('{tool=Edit|Write,id=/^T-/}')
  })
})

describe('tool-name aliases', () => {
  it('translates both ways, falling back to the name itself, and takes overrides', () => {
    const aliases = createToolNameAliases({ Bash: 'pwsh', Custom: 'my_tool' })
    expect(DEFAULT_TOOL_ALIASES.Bash).toBe('bash')
    expect(aliases.toHarness('Bash')).toBe('pwsh')
    expect(aliases.toMod('pwsh')).toBe('Bash')
    expect(aliases.toMod('bash')).toBe('bash')
    expect(aliases.toHarness('Custom')).toBe('my_tool')
    expect(aliases.toHarness('Read')).toBe('read')
    expect(aliases.toMod('read')).toBe('Read')
    expect(aliases.toMod('unknown_tool')).toBe('unknown_tool')
  })
})
