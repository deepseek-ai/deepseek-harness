import { describe, expect, it } from 'vitest'
import { builtDeclarationPath, usesCurrentDocumentApi } from './doc-typecheck-paths.ts'

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

it('checks current guides and ordinary docs but preserves frozen release examples', () => {
  expect(usesCurrentDocumentApi('docs/upgrade-guide/v0.2.1-alpha.4/subagents/guide.md', '0.2.1-alpha.4')).toBe(true)
  expect(usesCurrentDocumentApi('docs/upgrade-guide/v0.2.1-alpha.1/subagents/guide.md', '0.2.1-alpha.4')).toBe(false)
  expect(usesCurrentDocumentApi('docs/upgrade-guide/v0.2.1-alpha.4/subagents/guide.zh.md', '0.2.1-alpha.4')).toBe(true)
  expect(usesCurrentDocumentApi('packages/subagent/subagent/README.md', '0.2.1-alpha.4')).toBe(true)
  expect(usesCurrentDocumentApi('docs\\upgrade-guide\\v0.2.0\\subagents\\guide.md', '0.2.1-alpha.4')).toBe(false)
})
