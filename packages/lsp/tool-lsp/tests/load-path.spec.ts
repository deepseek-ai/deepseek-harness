/**
 * Loader export-shape guard for @deepseek-ai/dsh-tool-lsp. It is a NAMESPACE plugin with `inject`, so a
 * stray `export default apply` would make the Loader's `unwrapExports` collapse the module to the
 * bare `apply`, dropping `inject` (postmortem 0001). This verifies the namespace survives
 * `Loader.prototype.unwrapExports`; the `lsp-definition` ACP snapshot owns full app composition.
 */

import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as toolLsp from '@deepseek-ai/dsh-tool-lsp'

describe('dsh-tool-lsp Loader export-shape guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in toolLsp).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolLsp) as Record<string, unknown>
    expect(unwrapped).toBe(toolLsp)
    expect(unwrapped.name).toBe('tool-lsp')
    expect(unwrapped.inject).toEqual(['tools', 'lsp', 'systemPrompt', 'workingDirectory'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })
})
