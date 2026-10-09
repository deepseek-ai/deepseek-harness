/**
 * Real-load-path guard for @deepseek-ai/dsh-tool-fs-search. `tool-fs-search` is
 * a NAMESPACE plugin with `inject` — so a stray `export default apply` would
 * make the cordis Loader's `unwrapExports` (`exports.default ?? exports`)
 * collapse the module to the bare `apply` function, DROPPING `inject`. The
 * plugin would then read `ctx.subprocess` without having injected it and throw
 * `cannot get property … without inject` the moment it loads (postmortem 0001).
 *
 * A hand-built `ctx.plugin({ apply, inject })` mount CANNOT catch that — it
 * bypasses `unwrapExports`. So this test unwraps the module through the REAL
 * `Loader.prototype.unwrapExports` and mounts the result over the real local
 * subprocess service, exercising the exact path the Loader uses. Prove the
 * guard bites: add `export default apply` to `src/index.ts`, watch this go
 * red, revert.
 */

import { provideWorkingDirectoryFixture } from '@deepseek-ai/dsh-agent-loop-testkit'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalSubprocessRuntime from '@deepseek-ai/dsh-subprocess-local'
import * as toolFsSearch from '@deepseek-ai/dsh-tool-fs-search'

describe('dsh-tool-fs-search real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in toolFsSearch).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolFsSearch) as Record<string, unknown>
    expect(unwrapped).toBe(toolFsSearch)
    expect(unwrapped.name).toBe('tool-fs-search')
    expect(unwrapped.inject).toEqual(['tools', 'systemPrompt', 'subprocess', 'workingDirectory'])
    expect(typeof unwrapped.Config).toBe('function')
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.subprocess through the unwrapped module without an inject error', async () => {
    const ctx = new Context()
    provideWorkingDirectoryFixture(ctx)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalSubprocessRuntime)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(toolFsSearch) as Parameters<Context['plugin']>[0]
    // A collapsed export shape (dropped inject) would throw "without inject" here.
    const fiber = await ctx.plugin(unwrapped, { sampleOverCapGlobResults: true })
    expect(ctx.tools.schemas().map(s => s.name)).toEqual(expect.arrayContaining(['glob', 'grep']))
    await fiber.dispose()
  })
})
