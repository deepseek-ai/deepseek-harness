/** The bundle's manifest and patch: a standalone profile composed from one insert over the empty root. */
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
  dsh: { bundle: { patch: string; profile: string; platforms?: string[] } }
  dependencies: Record<string, string>
  optionalDependencies: Record<string, string>
}

const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as Manifest
const patches = load(readFileSync(resolve(root, manifest.dsh.bundle.patch), 'utf8'), { schema: entryListSchema }) as Array<
  { id?: string; disabled?: unknown; insert?: EntryOptions[] }
>
const inserted = patches.flatMap(patch => patch.insert ?? [])
const row = (id: string) => inserted.find(entry => entry.id === id)

describe('cua-mcp bundle', () => {
  it('publishes an unprefixed experimental bundle that declares its own profile and only macOS serves', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-cua-mcp')
    expect(manifest.publishConfig.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.exports).toHaveProperty('./locale/*.json')
    expect(manifest.dsh.bundle).toEqual({ patch: './cordis.patch.yml', profile: 'cua-mcp' })
    expect(Object.keys(manifest.optionalDependencies)).toEqual(['@deepseek-ai/dsh-experimental-cua-macos'])
    expect(readdirSync(resolve(root, 'locale')).sort()).toEqual(['de.json', 'en.json', 'es.json', 'fr.json', 'ja.json', 'pt.json', 'ru.json', 'zh.json'])
  })

  it('composes the standalone profile from one insert without model adapters, prompt tools, or telemetry', () => {
    expect(patches.map(patch => Object.keys(patch))).toEqual([['insert']])
    expect(inserted.map(entry => entry.id)).toEqual([
      'session', 'session-persistence-jsonl', 'session-projection', 'attachment-local', 'working-directory',
      'storage', 'storage-json', 'storage-domain',
      'subprocess', 'sandbox', 'sandbox-policy', 'approval', 'fs-sandbox',
      'tools', 'tool-executor-native', 'system-prompt', 'user-questions', 'llm', 'agent', 'agent-loop',
      'cua-mcp-presets', 'cua-mcp-preset', 'cua-mcp-computer-use', 'cua-mcp-provider', 'cua-mcp',
    ])
    // The llm hub carries no adapter row, so no model request can leave this profile.
    expect(inserted.map(entry => entry.name).filter(name => /llm|telemetry|otel|web|subagent|compaction|skill|plugin-manager/.test(name)))
      .toEqual(['@deepseek-ai/dsh-llm'])
    expect(row('agent-loop')?.config).toEqual({ agents: [] })
    expect(row('cua-mcp-presets')?.config).toEqual({ default: 'cua-mcp' })
    expect(row('cua-mcp-preset')?.config).toEqual({ id: 'cua-mcp', plugins: [] })
    for (const name of inserted.map(entry => entry.name)) {
      if (name === manifest.name) continue
      expect({ ...manifest.dependencies, ...manifest.optionalDependencies }).toHaveProperty(name)
    }
  })

  it('pins the file-effect boundary of every shipped CLI mode for program processes', () => {
    const policy = row('sandbox-policy')?.config as { mode: unknown; workspaceRoot: unknown }
    const approval = row('approval')?.config as { policy: unknown }
    expect(interpolate({ process: { env: {}, cwd: () => '/work' } }, policy.mode)).toBe('workspace-write')
    expect(interpolate({ process: { env: { DSH_PERMISSION_MODE: 'danger-full-access' }, cwd: () => '/work' } }, policy.mode)).toBe('danger-full-access')
    expect(interpolate({ process: { env: {}, cwd: () => '/work' } }, policy.workspaceRoot)).toBe('/work')
    expect(interpolate({ process: { env: {} } }, approval.policy)).toBe('ask')
    expect(interpolate({ process: { env: { DSH_PERMISSION_MODE: 'danger-full-access' } } }, approval.policy)).toBe('never')
  })

  it('mounts the macOS provider only on Darwin, with a fixed screenshot target and the PTC raw-tool preset', () => {
    const provider = row('cua-mcp-provider')
    expect(provider?.config).toEqual({ agentPreset: 'ptc', screenshotTarget: { longEdge: 2048, maxBytes: 2_097_152 } })
    for (const platform of ['darwin', 'linux', 'win32']) {
      expect(Boolean(interpolate({ process: { platform } }, provider?.disabled))).toBe(platform !== 'darwin')
    }
  })

  it('maps DSH_CUA_CONSENT onto the frontend consent and defaults to elicitation', () => {
    const consent = (row('cua-mcp')?.config as { consent: unknown }).consent
    expect(interpolate({ process: { env: {} } }, consent)).toBe('elicit')
    expect(interpolate({ process: { env: { DSH_CUA_CONSENT: 'allow' } } }, consent)).toBe('allow')
  })
})
