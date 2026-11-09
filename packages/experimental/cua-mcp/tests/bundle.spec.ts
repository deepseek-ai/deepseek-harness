/** The bundle's manifest and patch: a standalone profile frontend over dsh-base with a fixed-target CUA provider. */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('..', import.meta.url))

interface Manifest {
  name: string
  publishConfig: { access: string }
  icon: string
  exports: Record<string, unknown>
  dsh: { bundle: { patch: string; platforms?: string[] } }
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest
const patches = load(readFileSync(resolve(root, manifest.dsh.bundle.patch), 'utf8'), { schema: entryListSchema }) as Array<
  { id?: string; disabled?: unknown; insert?: EntryOptions[] }
>
const inserted = patches.flatMap(patch => patch.insert ?? [])

describe('cua-mcp bundle', () => {
  it('publishes an unprefixed experimental bundle that every Host installs and only macOS serves', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-cua-mcp')
    expect(manifest.publishConfig.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.exports).toHaveProperty('./locale/*.json')
    expect(manifest.dsh.bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(Object.keys(manifest.optionalDependencies)).toEqual(['@deepseek-ai/dsh-experimental-cua-macos'])
    expect(readdirSync(resolve(root, 'locale')).sort()).toEqual(['de.json', 'en.json', 'es.json', 'fr.json', 'ja.json', 'pt.json', 'ru.json', 'zh.json'])
  })

  it('switches off model-turn rows and inserts the preset, provider, and frontend rows', () => {
    expect(patches.filter(patch => patch.disabled === true).map(patch => patch.id))
      .toEqual(['session-title-llm', 'hmr', 'credentials', 'authorization', 'deepseek-account'])
    expect(inserted.map(row => [row.id, row.name])).toEqual([
      ['cua-mcp-presets', '@deepseek-ai/dsh-agent-preset-registry'],
      ['cua-mcp-preset', '@deepseek-ai/dsh-agent-preset'],
      ['cua-mcp-computer-use', '@deepseek-ai/dsh-computer-use'],
      ['cua-mcp-provider', '@deepseek-ai/dsh-experimental-cua-macos'],
      ['cua-mcp', '@deepseek-ai/dsh-cua-mcp'],
    ])
    const registry = inserted.find(row => row.id === 'cua-mcp-presets')
    const preset = inserted.find(row => row.id === 'cua-mcp-preset')
    expect(registry?.config).toEqual({ default: 'cua-mcp' })
    expect(preset?.config).toEqual({ id: 'cua-mcp', plugins: [] })
    for (const name of inserted.map(row => row.name)) {
      if (name === manifest.name) continue
      expect({ ...manifest.dependencies, ...manifest.optionalDependencies }).toHaveProperty(name)
    }
  })

  it('mounts the macOS provider only on Darwin, with a fixed screenshot target and the PTC raw-tool preset', () => {
    const provider = inserted.find(row => row.id === 'cua-mcp-provider')
    expect(provider?.config).toEqual({ agentPreset: 'ptc', screenshotTarget: { longEdge: 2048, maxBytes: 2_097_152 } })
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(Boolean(interpolate({ process: { platform } }, provider?.disabled))).toBe(platform !== 'darwin')
    }
  })

  it('maps DSH_CUA_CONSENT onto the frontend consent and defaults to elicitation', () => {
    const frontend = inserted.find(row => row.id === 'cua-mcp')
    const consent = (frontend?.config as { consent: unknown }).consent
    expect(interpolate({ process: { env: {} } }, consent)).toBe('elicit')
    expect(interpolate({ process: { env: { DSH_CUA_CONSENT: 'allow' } } }, consent)).toBe('allow')
  })
})
