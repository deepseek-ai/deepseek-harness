import { describe, expect, it } from 'vitest'
import { builtDeclarationPath, isFrozenUpgradeGuidePath } from './doc-typecheck-paths.ts'

describe('frozen upgrade-guide examples', () => {
  it('excludes earlier release guides in both languages from current API compilation', () => {
    expect(isFrozenUpgradeGuidePath('docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.md', '0.2.1-rc.2')).toBe(true)
    expect(isFrozenUpgradeGuidePath('docs/upgrade-guide/v0.2.1-alpha.1/subagent-activations/guide.zh.md', '0.2.1-rc.2')).toBe(true)
  })

  it.each([
    'docs/upgrade-guide/v0.2.1-rc.2/subagent-activations/guide.md',
    'docs/upgrade-guide/v0.2.1-rc.3/subagent-activations/guide.md',
    'docs/upgrade-guide/vinvalid/subagent-activations/guide.md',
    'docs/subsystems/subagent.md',
  ])('keeps %s subject to current API compilation', (file) => {
    expect(isFrozenUpgradeGuidePath(file, '0.2.1-rc.2')).toBe(false)
  })
})

describe('builtDeclarationPath', () => {
  it('maps package source directories and exact entry files to built declarations', () => {
    expect(builtDeclarationPath('./packages/*/*/src')).toBe('./packages/*/*/lib/types')
    expect(builtDeclarationPath('./packages/core/session/src/index.ts'))
      .toBe('./packages/core/session/lib/types/index.d.ts')
    expect(builtDeclarationPath('./packages/core/session/src/types.ts'))
      .toBe('./packages/core/session/lib/types/types.d.ts')
    expect(builtDeclarationPath('./packages/experimental/claude-code-mods/examples/*'))
      .toBe('./packages/experimental/claude-code-mods/examples/*')
  })

  it('rejects aliases without a supported source target', () => {
    expect(() => builtDeclarationPath('./packages/core/session/source/index.ts'))
      .toThrow('cannot map workspace source path')
  })
})
