/** The standalone SDK-minimal bundle's complete declared Cordis tree. */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'

function packageName(specifier: string): string {
  return specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0]!
}

describe('dsh-sdk-minimal bundle', () => {
  it('declares one standalone allowlisted tree with every row dependency', () => {
    const root = fileURLToPath(new URL('..', import.meta.url))
    const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      dsh?: { bundle?: { patch?: string } }
    }
    expect(manifest.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
    const patches = yaml.load(
      readFileSync(resolve(root, manifest.dsh!.bundle!.patch!), 'utf8'),
      { schema: entryListSchema },
    ) as Array<{ insert?: Array<{ id?: string; inject?: string[]; name?: string; config?: Record<string, unknown>; disabled?: unknown }> }>
    expect(patches).toHaveLength(1)
    const rows = patches[0]?.insert ?? []
    expect(rows.map(row => [row.id, row.name])).toEqual([
      ['sdk-app-startup', '@deepseek-ai/dsh-sdk-app'],
      ['sdk-jsonrpc-server', '@deepseek-ai/dsh-sdk-jsonrpc-server'],
      ['deepseek-llm-api-extensions', '@deepseek-ai/dsh-deepseek-llm-api-extensions'],
      ['session-log-deepseek', '@deepseek-ai/dsh-session-log-deepseek'],
      ['plugin-package-inventory-deepseek', '@deepseek-ai/dsh-plugin-package-inventory-deepseek'],
      ['llm-deepseek', '@deepseek-ai/dsh-llm-deepseek'],
      ['sandbox', '@deepseek-ai/dsh-sandbox-local'],
      ['session-projection', '@deepseek-ai/dsh-session-projection'],
      ['sandbox-policy', '@deepseek-ai/dsh-sandbox-policy'],
      ['subprocess', '@deepseek-ai/dsh-subprocess-local'],
      ['pty', '@deepseek-ai/dsh-terminal'],
      ['terminal-bash', '@deepseek-ai/dsh-terminal-bash'],
      ['terminal-pwsh', '@deepseek-ai/dsh-terminal-bash'],
      ['fs-local', '@deepseek-ai/dsh-fs-local'],
      ['timer', '@deepseek-ai/cordis-plugin-timer'],
      ['llm', '@deepseek-ai/dsh-llm'],
      ['session', '@deepseek-ai/dsh-session'],
      ['session-title', '@deepseek-ai/dsh-session-title'],
      ['system-prompt', '@deepseek-ai/dsh-system-prompt'],
      ['tools', '@deepseek-ai/dsh-tools'],
      ['agent', '@deepseek-ai/dsh-agent'],
      ['llm-retry', '@deepseek-ai/dsh-llm-retry'],
      ['jobs', '@deepseek-ai/dsh-jobs-local'],
      ['invariants', '@deepseek-ai/dsh-invariants'],
      ['session-invariant', '@deepseek-ai/dsh-session/invariant'],
      ['agent-invariant', '@deepseek-ai/dsh-agent/invariant'],
      ['scope-invariant', '@deepseek-ai/dsh-scope/invariant'],
      ['agent-loop-invariant', '@deepseek-ai/dsh-agent-loop/invariant'],
      ['agent-loop', '@deepseek-ai/dsh-agent-loop'],
      ['persistent-bash', '@deepseek-ai/dsh-tool-bash-persistent'],
      ['persistent-pwsh', '@deepseek-ai/dsh-tool-pwsh-persistent'],
      ['str-replace-editor', '@deepseek-ai/dsh-tool-str-replace-editor'],
      ['sessions', '@deepseek-ai/dsh-session-persistence-jsonl'],
    ])
    expect(rows.find(row => row.id === 'sdk-app-startup')?.config).toEqual({ profile: 'sdk-minimal' })
    expect(rows.find(row => row.id === 'sdk-jsonrpc-server')).toMatchObject({
      inject: ['sdkAppStartup', 'loader'],
      config: { maxTokensAsSuccess: false },
    })
    expect(rows.find(row => row.id === 'llm-deepseek')?.config).toEqual({
      apiKeyEnv: 'DEEPSEEK_API_KEY',
      defaultContextWindow: { __jsExpr: 'Number(process.env.DSH_CONTEXT_WINDOW ?? 1000000)' },
      streamIdleTimeoutMs: 172800000,
    })
    expect(rows.find(row => row.id === 'system-prompt')?.config).toEqual({
      includeHarnessIdentity: false,
      includeRuntimeContext: false,
      personaPrefix: { __jsExpr: "process.env.DSH_SYSTEM_PROMPT ?? 'You are a helpful software engineer assistant.'" },
    })
    expect(rows.find(row => row.id === 'agent-loop')?.config).toEqual({ agents: [] })
    expect(rows.find(row => row.id === 'terminal-bash')).toMatchObject({
      disabled: { __jsExpr: "process.platform === 'win32'" },
    })
    expect(rows.find(row => row.id === 'terminal-pwsh')).toMatchObject({
      disabled: { __jsExpr: "process.platform !== 'win32'" },
      config: { shellDialect: 'pwsh', timeoutMs: 300000 },
    })
    expect(Object.keys(manifest.dependencies ?? {}).sort()).toEqual(
      [...new Set(rows.map(row => row.name).filter((name): name is string => name !== undefined).map(packageName))].sort(),
    )
  })
})
