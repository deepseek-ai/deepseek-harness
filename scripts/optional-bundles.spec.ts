/** The delivered Web composition's Schedule rows, the optional bundles it ships switched off, and their display metadata. */

import { globSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadOverlayPatches } from '../packages/boot/app-boot/src/index.ts'
import { readPluginMeta } from '../packages/boot/app-boot/src/package-meta.ts'
import { OPTIONAL_BUNDLES, bundlePatchPaths, composeEntries } from '../packages/boot/app-boot/src/profile.ts'
import type { DshBundleManifest } from '../packages/util/package-manifest/src/types.ts'

const root = resolve(import.meta.dirname, '..')

interface Manifest {
  name: string
  dsh?: { bundle?: DshBundleManifest }
}

const bundles = new Map(globSync('packages/*/*/package.json', { cwd: root }).map((path) => {
  const manifest = JSON.parse(readFileSync(resolve(root, path), 'utf8')) as Manifest
  return [manifest.name, { dir: dirname(resolve(root, path)), manifest }]
}))

function bundle(name: string): { dir: string; patches: ReturnType<typeof loadOverlayPatches> } {
  const entry = bundles.get(name)
  if (entry?.manifest.dsh?.bundle === undefined) throw new Error(`${name} is not a workspace bundle`)
  return { dir: entry.dir, patches: bundlePatchPaths(entry.dir, entry.manifest.dsh.bundle).flatMap(path => loadOverlayPatches('test', path)) }
}

describe('optional bundles', () => {
  const shipped = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].map(name => bundle(name).patches)

  it('ships at least one bundle switched off', () => {
    expect(OPTIONAL_BUNDLES.length).toBeGreaterThan(0)
  })

  it('keeps the Inspector out of the default plugin list', () => {
    expect(OPTIONAL_BUNDLES).not.toContain('@deepseek-ai/dsh-experimental-inspector')
  })

  it.each(OPTIONAL_BUNDLES)('%s composes over the Web profile without a skipped patch', (name) => {
    const { patches } = bundle(name)
    const warnings: string[] = []
    const composed = composeEntries([...shipped, patches], message => warnings.push(message))
    const ids = new Set(composed.map(entry => entry.id))
    expect(warnings).toEqual([])
    // Inserted rows carry stable ids at the profile root, so a later profile patch can configure or disable them.
    for (const row of patches.flatMap(patch => patch.insert ?? [])) {
      expect(typeof row.id).toBe('string')
      expect(ids.has(row.id)).toBe(true)
    }
    // One top-level row per id: a duplicate declaration leaves the Loader with the last one, silently
    // replacing the layer that declared the id first.
    const topLevelIds = composed.flatMap(entry => typeof entry.id === 'string' ? [entry.id] : [])
    expect(topLevelIds).toHaveLength(new Set(topLevelIds).size)
    // An id-targeted patch reaches a row another layer inserted: the id resolves to exactly one top-level
    // row, and the override keeps the package the shipped layer declared on it.
    const shippedComposed = composeEntries([...shipped])
    for (const patch of patches) {
      if (patch.insert !== undefined || typeof patch.id !== 'string') continue
      const matches = composed.filter(entry => entry.id === patch.id)
      expect(matches).toHaveLength(1)
      expect(matches[0]?.name).toBe(shippedComposed.find(entry => entry.id === patch.id)?.name)
    }
  })

  it('delivers the Schedule service and task page without a Host clock row', () => {
    const composed = composeEntries(shipped)
    // The delivered composition carries the Host Schedule service and its task
    // page enabled; the clock stays preset-level, so no Host row declares it.
    for (const row of [
      { id: 'schedule', name: '@deepseek-ai/dsh-schedule' },
      { id: 'ui-schedule', name: '@deepseek-ai/dsh-client-ui-schedule' },
    ]) {
      expect(composed.filter(entry => entry.id === row.id && entry.name === row.name && entry.disabled !== true))
        .toHaveLength(1)
    }
    expect(composed.some(entry => entry.id === 'time-context')).toBe(false)
  })

  it('keeps the clock and the reminder tools on the presets that declare them', () => {
    const composed = composeEntries(shipped)
    type PresetRow = { id?: string; name?: string; disabled?: boolean; config?: unknown }
    const presetPlugins = (id: string): PresetRow[] => {
      const row = composed.find(entry => entry.id === id)
      if (row === undefined) throw new Error(`missing delivered preset row ${id}`)
      const flat: PresetRow[] = []
      // A `cordis:group` row nests its children in its own `config` array.
      const walk = (rows: PresetRow[]): void => {
        for (const entry of rows) {
          flat.push(entry)
          if (Array.isArray(entry.config)) walk(entry.config as PresetRow[])
        }
      }
      walk((row.config as { plugins: PresetRow[] }).plugins)
      return flat
    }
    for (const id of ['preset-standard', 'preset-cordis', 'preset-ptc']) {
      const plugins = presetPlugins(id)
      for (const plugin of [
        { id: 'time-context', name: '@deepseek-ai/dsh-time-context' },
        { id: 'tool-schedule', name: '@deepseek-ai/dsh-tool-schedule' },
      ]) {
        const matches = plugins.filter(row => row.id === plugin.id && row.name === plugin.name)
        expect(matches).toHaveLength(1)
        expect(matches[0]?.disabled).not.toBe(true)
      }
    }
    // A delegated child cannot arm reminders: both delegation rows deny the four
    // tools, so a child's prompt never lists them.
    for (const id of ['preset-standard', 'preset-cordis', 'preset-ptc']) {
      for (const rowId of ['tool-subagent', 'tool-subagent-fork']) {
        expect(presetPlugins(id).find(plugin => plugin.id === rowId)?.config).toMatchObject({
          toolFilter: { deny: ['schedule_create', 'schedule_delete', 'schedule_list', 'schedule_update'] },
        })
      }
    }
    // `minimal` declares neither, so it composes no clock reading and no reminder tool.
    expect(presetPlugins('preset-minimal').some(row => row.name === '@deepseek-ai/dsh-time-context'
      || row.name === '@deepseek-ai/dsh-tool-schedule')).toBe(false)
  })

  it.each(OPTIONAL_BUNDLES)('%s resolves a title, description, and icon in both shipped languages', (name) => {
    const meta = readPluginMeta(name, pathToFileURL(`${bundle(name).dir}/package.json`).href)
    expect(meta?.error).toBeUndefined()
    for (const field of [meta?.title, meta?.description]) {
      expect(typeof field).toBe('object')
      for (const language of ['en', 'zh']) expect((field as Record<string, string>)[language]).toMatch(/\S/)
    }
    expect(meta?.icon).toMatch(/^data:image\//)
  })
})
