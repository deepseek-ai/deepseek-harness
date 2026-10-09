import { describe, expect, it } from 'vitest'
import { parseClaudeCodeConfig, substituteCommand } from '@deepseek-ai/dsh-hooks-claude-code/src/config.ts'

describe('substituteCommand', () => {
  it('replaces CLAUDE_PLUGIN_ROOT and CLAUDE_PROJECT_DIR (all occurrences)', () => {
    expect(substituteCommand('${CLAUDE_PLUGIN_ROOT}/x.sh', { pluginRoot: '/p' })).toBe('/p/x.sh')
    expect(substituteCommand('${CLAUDE_PROJECT_DIR}/a ${CLAUDE_PROJECT_DIR}/b', { projectDir: '/proj' })).toBe('/proj/a /proj/b')
    expect(substituteCommand('${CLAUDE_PLUGIN_ROOT}-${CLAUDE_PROJECT_DIR}', { pluginRoot: '/p', projectDir: '/d' })).toBe('/p-/d')
  })
  it('leaves the command untouched when no vars are supplied', () => {
    expect(substituteCommand('${CLAUDE_PLUGIN_ROOT}/x', {})).toBe('${CLAUDE_PLUGIN_ROOT}/x')
  })
})

describe('parseClaudeCodeConfig', () => {
  it('parses a bare event map and a settings-style { hooks: … } wrapper identically', () => {
    const groups = { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'x.sh' }] }] }
    const bare = parseClaudeCodeConfig(groups)
    const wrapped = parseClaudeCodeConfig({ hooks: groups })
    expect(bare.config).toEqual(wrapped.config)
    expect(bare.config.PreToolUse).toEqual([{ matcher: 'Bash', hooks: [{ command: 'x.sh' }] }])
  })

  it('carries timeout → timeoutSec and substitutes the command', () => {
    const { config } = parseClaudeCodeConfig(
      { Stop: [{ hooks: [{ type: 'command', command: '${CLAUDE_PLUGIN_ROOT}/s.sh', timeout: 30 }] }] },
      { pluginRoot: '/p' },
    )
    expect(config.Stop).toEqual([{ hooks: [{ command: '/p/s.sh', timeoutSec: 30 }] }])
  })

  it('skips non-command hooks (recorded) and keeps the command ones in the same group', () => {
    const { config, skipped } = parseClaudeCodeConfig({
      PreToolUse: [{ hooks: [
        { type: 'prompt', prompt: 'hi' },
        { type: 'command', command: 'ok.sh' },
        { type: 'http', url: 'http://x' },
      ] }],
    })
    expect(config.PreToolUse).toEqual([{ hooks: [{ command: 'ok.sh' }] }])
    expect(skipped).toEqual([{ event: 'PreToolUse', type: 'prompt' }, { event: 'PreToolUse', type: 'http' }])
  })

  it('treats a hook with no `type` as a command (CC default)', () => {
    const { config } = parseClaudeCodeConfig({ Stop: [{ hooks: [{ command: 'd.sh' }] }] })
    expect(config.Stop).toEqual([{ hooks: [{ command: 'd.sh' }] }])
  })

  it('drops malformed entries without throwing: non-array groups, non-object group/hook, missing command, empty groups', () => {
    expect(parseClaudeCodeConfig({ PreToolUse: 'nope' }).config).toEqual({})
    expect(parseClaudeCodeConfig({ PreToolUse: [42, { hooks: 'no' }, { hooks: [7, { type: 'command' }] }] }).config).toEqual({})
    // a group whose only hook lacks a command string drops the whole (empty) group
    expect(parseClaudeCodeConfig({ Stop: [{ hooks: [{ type: 'command', command: 5 }] }] }).config).toEqual({})
  })

  it('returns empty for a non-object / null / array top level', () => {
    expect(parseClaudeCodeConfig(null).config).toEqual({})
    expect(parseClaudeCodeConfig(42).config).toEqual({})
    expect(parseClaudeCodeConfig([1, 2]).config).toEqual({})
  })

  it('omits the matcher key when the group has none (match-all)', () => {
    const { config } = parseClaudeCodeConfig({ Stop: [{ hooks: [{ type: 'command', command: 's.sh' }] }] })
    expect('matcher' in config.Stop![0]!).toBe(false)
  })

  it('rejects an invalid regex matcher with its event name', () => {
    expect(() => parseClaudeCodeConfig({
      PreToolUse: [{ matcher: '(', hooks: [{ type: 'command', command: 'x.sh' }] }],
    })).toThrow('invalid claude-code regex matcher "(" on event "PreToolUse"')
  })

  it('discards matcher fields on events without matcher subjects before validation', () => {
    const { config } = parseClaudeCodeConfig({
      UserPromptSubmit: [{ matcher: '[', hooks: [{ type: 'command', command: 'prompt.sh' }] }],
      Stop: [{ matcher: '(', hooks: [{ type: 'command', command: 'stop.sh' }] }],
    })

    expect(config).toEqual({
      UserPromptSubmit: [{ hooks: [{ command: 'prompt.sh' }] }],
      Stop: [{ hooks: [{ command: 'stop.sh' }] }],
    })
  })

  it('ignores invalid matchers on unsupported events without dropping supported hooks', () => {
    const { config } = parseClaudeCodeConfig({
      Setup: [{ matcher: '(', hooks: [{ type: 'command', command: 'ignored.sh' }] }],
      PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'kept.sh' }] }],
    })

    expect(config).toEqual({
      PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'kept.sh' }] }],
    })
  })
})
