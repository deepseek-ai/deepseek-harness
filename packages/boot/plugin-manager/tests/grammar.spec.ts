import { describe, expect, it } from 'vitest'
import {
  formatPluginMention, isPluginPackageName, nextPluginMention, packageNameOfPluginMention,
  parsePluginMentions,
} from '../src/grammar.ts'

describe('plugin reference grammar', () => {
  it('round-trips a package and an escaped label through a canonical mention', () => {
    const mention = formatPluginMention({ packageName: '@acme/plugin', label: 'Acme [plugin] \\ one' })
    expect(mention).toBe('@[Acme [plugin\\] \\\\ one](dsh-plugin:@acme/plugin)')
    expect(parsePluginMentions(`Use ${mention} now`)).toEqual([{ packageName: '@acme/plugin', label: 'Acme [plugin] \\ one' }])
    expect(formatPluginMention({ packageName: '@acme/plugin' })).toBe('@[@acme/plugin](dsh-plugin:@acme/plugin)')
  })

  it('refuses to format a name that is not a bare package', () => {
    expect(isPluginPackageName('@acme/plugin')).toBe(true)
    expect(isPluginPackageName('@acme/plugin/client')).toBe(false)
    expect(() => formatPluginMention({ packageName: 'Bad Name' })).toThrow('invalid plugin package name "Bad Name"')
  })

  it('leaves a mention whose URI names no bare package as ordinary text', () => {
    const text = 'A @[bad](dsh-plugin:INVALID) and @[ok](dsh-plugin:@acme/plugin) end'
    expect(parsePluginMentions(text)).toEqual([{ packageName: '@acme/plugin', label: 'ok' }])
    expect(parsePluginMentions('no mention')).toEqual([])
  })

  it('locates the nearest mention at or after an offset', () => {
    const mention = '@[Acme](dsh-plugin:@acme/plugin)'
    const text = `${mention} and ${mention}`
    expect(nextPluginMention(text)).toEqual({ start: 0, end: mention.length, packageName: '@acme/plugin', label: 'Acme' })
    expect(nextPluginMention(text, 1)?.start).toBe(mention.length + 5)
    expect(nextPluginMention(text, text.length)).toBeUndefined()
  })

  it('names the package only when one mention occupies the whole string', () => {
    const mention = '@[Acme](dsh-plugin:@acme/plugin)'
    expect(packageNameOfPluginMention(mention)).toBe('@acme/plugin')
    expect(packageNameOfPluginMention(` ${mention}`)).toBeUndefined()
    expect(packageNameOfPluginMention(`${mention} tail`)).toBeUndefined()
    expect(packageNameOfPluginMention('plain')).toBeUndefined()
  })
})
