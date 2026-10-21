/**
 * Real-load-path guard for @deepseek-ai/dsh-mcp-client. `mcp-client` is a
 * NAMESPACE plugin with `inject` — so a stray `export default apply` would
 * make the cordis Loader's `unwrapExports` (`exports.default ?? exports`)
 * collapse the module to the bare `apply` function, DROPPING `inject`. The
 * plugin would then read `ctx.tools` without having injected it and throw
 * `cannot get property … without inject` the moment it loads (postmortem 0001).
 *
 * This test unwraps the module through the REAL `Loader.prototype.unwrapExports`
 * and verifies the namespace shape is preserved.
 */

import { describe, expect, it } from 'vitest'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as mcpClient from '@deepseek-ai/dsh-mcp-client'

describe('dsh-mcp-client real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in mcpClient).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(mcpClient) as Record<string, unknown>
    expect(unwrapped).toBe(mcpClient)
    expect(unwrapped.name).toBe('mcp-client')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })
})
