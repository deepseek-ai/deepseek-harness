import { describe, expect, it } from 'vitest'
import { CommandDefinitionId } from '../src/brand.ts'
import { builtinCommandName, builtinCommandTokens, resolveCommand } from '../src/builtin.ts'
import type { CommandDescriptor } from '../src/types.ts'

const definitions = [
  ['goal', '@deepseek-ai/dsh-command-goal'],
  ['plan', '@deepseek-ai/dsh-plan-mode'],
  ['feedback', '@deepseek-ai/dsh-command-feedback'],
  ['compact', '@deepseek-ai/dsh-command-compact'],
  ['permission', '@deepseek-ai/dsh-permission-presets'],
  ['export', '@deepseek-ai/dsh-session-log-export'],
] as const

describe('builtin command resolution', () => {
  it.each(definitions)('follows the %s identity through canonical, Chinese and renamed input', (name, id) => {
    const descriptor: CommandDescriptor = {
      name: `renamed-${name}`, definitionId: CommandDefinitionId(id), description: 'Renamed command',
    }
    expect(builtinCommandName(descriptor)).toBe(name)
    for (const token of [builtinCommandTokens.en[name], builtinCommandTokens.zh[name], descriptor.name]) {
      expect(resolveCommand(token, [descriptor])).toBe(descriptor)
    }
  })

  it('retains exact-name priority without assigning builtin identity to the replacement', () => {
    const builtin: CommandDescriptor = {
      name: 'planning', definitionId: CommandDefinitionId('@deepseek-ai/dsh-plan-mode'), description: 'Plan',
    }
    const replacement: CommandDescriptor = {
      name: 'plan', definitionId: CommandDefinitionId('example/plan'), description: 'Other command',
    }
    expect(resolveCommand('plan', [builtin, replacement])).toBe(replacement)
    expect(builtinCommandName(replacement)).toBeUndefined()
    expect(resolveCommand('计划', [builtin, replacement])).toBe(builtin)
    expect(resolveCommand('missing', [builtin])).toBeUndefined()
    expect(resolveCommand('plan', [])).toBeUndefined()
  })
})
