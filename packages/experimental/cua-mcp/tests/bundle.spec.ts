/** The bundle's manifest and patch: a standalone profile composed from one insert over the empty root. */
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEntryYaml } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { interpolate } from '@deepseek-ai/cordis-plugin-loader'
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
const patches = parseEntryYaml(readFileSync(resolve(root, manifest.dsh.bundle.patch), 'utf8')) as Array<
  { id?: string; disabled?: unknown; insert?: EntryOptions[] }
>
const inserted = patches.flatMap(patch => patch.insert ?? [])
const row = (id: string) => inserted.find(entry => entry.id === id)

describe('cua-mcp bundle', () => {
  it('publishes an unprefixed experimental bundle whose patch is its only declaration, with both native providers optional', () => {
    expect(manifest.name).toBe('@deepseek-ai/dsh-cua-mcp')
    expect(manifest.publishConfig.access).toBe('public')
    expect(manifest.icon).toBe('./icon.svg')
    expect(manifest.exports).toHaveProperty('./locale/*.json')
    expect(manifest.dsh.bundle).toEqual({ patch: './cordis.patch.yml' })
    expect(Object.keys(manifest.optionalDependencies)).toEqual(['@deepseek-ai/dsh-cua-macos', '@deepseek-ai/dsh-cua-windows'])
    expect(readdirSync(resolve(root, 'locale')).sort()).toEqual(['de.json', 'en.json', 'es.json', 'fr.json', 'ja.json', 'pt.json', 'ru.json', 'zh.json'])
  })

  it('composes the standalone profile from one insert without model adapters, prompt tools, or telemetry', () => {
    expect(patches.map(patch => Object.keys(patch))).toEqual([['insert']])
    expect(inserted.map(entry => entry.id)).toEqual([
      'session', 'session-persistence-jsonl', 'session-projection', 'attachment-local', 'working-directory',
      'storage', 'storage-json', 'storage-domain',
      'subprocess', 'sandbox', 'sandbox-policy', 'approval', 'fs-sandbox',
      'tools', 'tool-executor-native', 'system-prompt', 'user-questions', 'llm', 'agent', 'agent-loop',
      'cua-mcp-presets', 'cua-mcp-preset', 'cua-mcp-computer-use', 'cua-mcp-provider', 'cua-mcp-provider-windows', 'cua-mcp',
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
    expect(interpolate({ process: { env: {} } }, policy.mode)).toBe('workspace-write')
    expect(interpolate({ process: { env: { DSH_PERMISSION_MODE: 'danger-full-access' } } }, policy.mode)).toBe('danger-full-access')
    expect(interpolate({ process: { env: {} } }, approval.policy)).toBe('ask')
    expect(interpolate({ process: { env: { DSH_PERMISSION_MODE: 'danger-full-access' } } }, approval.policy)).toBe('never')
  })

  it('keeps programs in a workspace inside the Harness home unless DSH_CUA_WORKSPACE names another directory', () => {
    const dshHomePath = (...segments: string[]) => ['/home/me/.dsh', ...segments].join('/')
    // The directory the client launched the server from is never the workspace.
    const launched = { env: {}, cwd: () => '/' }
    const pinned = { env: { DSH_CUA_WORKSPACE: '/projects/desk' }, cwd: () => '/' }
    // The frontend row sets the Agent's working directory, which is a program's workspace-write root; the policy
    // row's root is the fallback for calls without a Session, so both rows resolve the same directory.
    for (const value of [(row('cua-mcp')?.config as { workspace: unknown }).workspace, (row('sandbox-policy')?.config as { workspaceRoot: unknown }).workspaceRoot]) {
      expect(interpolate({ process: launched, dshHomePath }, value)).toBe('/home/me/.dsh/cua-mcp/workspace')
      expect(interpolate({ process: pinned, dshHomePath }, value)).toBe('/projects/desk')
    }
  })

  it('mounts one native provider per Host, each with a fixed screenshot target and the PTC raw-tool preset', () => {
    const providers = { darwin: row('cua-mcp-provider'), win32: row('cua-mcp-provider-windows') }
    expect(providers.darwin?.name).toBe('@deepseek-ai/dsh-cua-macos')
    expect(providers.win32?.name).toBe('@deepseek-ai/dsh-cua-windows')
    for (const [host, provider] of Object.entries(providers)) {
      expect(provider?.config).toEqual({ agentPreset: 'ptc', screenshotTarget: { longEdge: 2048, maxBytes: 2_097_152 } })
      // Each row loads on its own Host only: elsewhere its optional provider package can be absent.
      for (const platform of ['darwin', 'linux', 'win32']) {
        expect(Boolean(interpolate({ process: { platform } }, provider?.disabled))).toBe(platform !== host)
      }
    }
  })

  it('maps DSH_CUA_CONSENT onto the frontend consent and defaults to elicitation', () => {
    const consent = (row('cua-mcp')?.config as { consent: unknown }).consent
    expect(interpolate({ process: { env: {} } }, consent)).toBe('elicit')
    expect(interpolate({ process: { env: { DSH_CUA_CONSENT: 'allow' } } }, consent)).toBe('allow')
  })
})
