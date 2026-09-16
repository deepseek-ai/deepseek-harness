import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import {
  DEFAULT_PREFERENCE, THEME_SETTINGS_NAMESPACE, apply,
} from '@deepseek-ai/dsh-client-ui-theme'

class MemorySettings extends SettingsProvider {
  readonly writable = true
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> {
    return Promise.resolve()
  }
}

/** Collect the injection table the way an index render or boot payload does. */
function collect(ctx: Context): IndexInjection[] {
  const table: IndexInjection[] = []
  ctx.emit('webserver/index-inject', table)
  return table
}

/** Narrow a theme style or script row and return its text. */
function rowText(row: IndexInjection | undefined): string {
  if (row?.kind !== 'script' && row?.kind !== 'style') throw new Error('expected a style or script row')
  return row.text
}

describe('ui-theme host', () => {
  it('registers, validates, and disposes the durable theme namespace with its fiber', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const ns = THEME_SETTINGS_NAMESPACE
    expect(ctx.settings.get(ns)).toEqual({ preference: DEFAULT_PREFERENCE, fontSize: 14 })
    await ctx.settings.update(ns, { preference: 'dark', fontSize: 16 })
    expect(ctx.settings.get(ns)).toEqual({ preference: 'dark', fontSize: 16 })
    await expect(ctx.settings.update(ns, { preference: 'sepia' })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { fontSize: 11 })).rejects.toThrow()
    await expect(ctx.settings.update(ns, { fontSize: 18 })).rejects.toThrow()
    await fiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns)).not.toContain(ns)
  })

  it('answers each collection with the current durable preference until disposal', async () => {
    const ctx = new Context()
    await ctx.plugin(MemorySettings).await()
    ctx.on('webserver/index-inject', (table) => {
      table.push({ kind: 'script', placement: 'head', text: 'window.afterTheme=true' })
    })
    const fiber = ctx.plugin({ apply })
    await fiber.await()
    const rows = collect(ctx)
    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ kind: 'style' })
    expect(rows[1]).toMatchObject({ kind: 'script', placement: 'body' })
    expect(rows[2]).toMatchObject({ kind: 'script', placement: 'head', text: 'window.afterTheme=true' })
    expect(rowText(rows[0])).toContain('@media(prefers-color-scheme:dark)')
    expect(rowText(rows[1])).toContain('const preference = "system"')
    expect(rowText(rows[1])).toContain('"14px"')
    await ctx.settings.update(THEME_SETTINGS_NAMESPACE, { preference: 'dark', fontSize: 17 })
    expect(rowText(collect(ctx)[0])).toContain('color-scheme:dark')
    expect(rowText(collect(ctx)[1])).toContain('const preference = "dark"')
    expect(rowText(collect(ctx)[1])).toContain('"17px"')
    await fiber.dispose()
    expect(collect(ctx)).toEqual([{ kind: 'script', placement: 'head', text: 'window.afterTheme=true' }])
  })

  it('uses the system preference without a settings provider', async () => {
    const ctx = new Context()
    await ctx.plugin({ apply }).await()
    expect(rowText(collect(ctx)[1])).toContain('const preference = "system"')
  })

  it('falls back to the schema default while the theme namespace holds no section', async () => {
    // A settings provider whose namespace read comes back empty (registration
    // still pending or a provider without schema defaults).
    const ctx = new Context()
    ctx.provide('settings', { register: () => () => {}, get: () => undefined } as never)
    await ctx.plugin({ apply }).await()
    expect(rowText(collect(ctx)[1])).toContain('const preference = "system"')
  })
})
