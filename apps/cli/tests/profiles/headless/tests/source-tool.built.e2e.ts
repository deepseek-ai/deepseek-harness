/**
 * Source CLI tool execution with the native addon and generated typert contributors
 * prepared by the build-backed smoke lane; core workspace modules must stay in src.
 *
 * The assertion accepts a real tool result or an explicit SandboxUnavailableError: the
 * subject is that a source-profile tool call reaches tool/result through one Tools instance,
 * not that the host can confine the shell. keyless-smoke.e2e.ts in the same gate owns the
 * confinement round trip and stays strict; on CI prepare-ci-bubblewrap.sh makes both paths
 * succeed, so the error branch only runs on hosts whose sandbox probe fails.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clearedProxyEnv } from '@deepseek-ai/dsh-http-proxy'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import type { SourceToolEvidence } from '../../../fixtures/source-tool-driver.ts'

const repoRoot = fileURLToPath(new URL('../../../../../../', import.meta.url))
const dshSourceBin = 'apps/cli/src/bin.ts'
const sourceToolTimeoutMs = 90_000

describe.skipIf(!existsSync(join(repoRoot, 'apps/cli/lib/bin.js')))('dsh SOURCE tools with prepared runtime artifacts', () => {
  it('dispatches a source-profile shell call to a result, including sandbox-unavailable hosts, without mixing tools src/lib', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-source-tool-'))
    try {
      const cwd = join(root, 'workspace')
      await mkdir(cwd)
      const patch = join(root, 'source-tool.patch.yml')
      await writeFile(patch, JSON.stringify([
        { id: 'headless-startup', disabled: true },
        { id: 'headless-runner', disabled: true },
        { id: 'llm-deepseek', disabled: true },
        { id: 'agent-default-model', config: { provider: 'cli-mock', model: 'cli-mock' } },
        { insert: [
          {
            id: 'cli-mock-llm',
            name: join(repoRoot, 'packages/test-support/loader-smoke/tests/fixtures/cli-mock-llm.ts'),
          },
          {
            id: 'source-tool-driver',
            name: fileURLToPath(new URL('../../../fixtures/source-tool-driver.ts', import.meta.url)),
            config: { cwd },
          },
        ] },
      ]))
      // Source modules and driver stay unbuilt; native and generated runtime artifacts are required.
      const result = await execa(process.execPath, [
        '--import', 'tsx/esm', dshSourceBin, '--profile', 'headless', '--patch', patch,
      ], {
        cwd: repoRoot,
        env: {
          ...clearedProxyEnv(),
          DSH_HOME: join(root, 'home'),
          DSH_AGENTS_HOME: join(root, 'agents'),
          DSH_TELEMETRY_DISABLED: '1',
          DSH_TOOLS_MODE: 'native',
          DSH_CLI_MOCK_FAILURE: '0',
        },
        input: '',
        timeout: sourceToolTimeoutMs - 15_000,
        killSignal: 'SIGKILL',
        reject: false,
      })
      const diagnostic = `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`
      expect(result.timedOut, diagnostic).toBe(false)
      expect(result.signal, diagnostic).toBeUndefined()
      expect(result.exitCode, diagnostic).toBe(0)
      const records = result.stdout.split('\n').filter(line => line.startsWith('DSH_SOURCE_TOOL_RESULT '))
      expect(records, diagnostic).toHaveLength(1)
      const evidence = JSON.parse(records[0]!.slice('DSH_SOURCE_TOOL_RESULT '.length)) as SourceToolEvidence
      expect(evidence.execArgv).toEqual(['--import', 'tsx/esm'])
      expect(evidence.errors).toEqual([])
      for (const pkg of ['tools', 'agent-loop']) {
        expect(evidence.modules.filter(url => url.endsWith(`/packages/core/${pkg}/src/index.ts`))).toHaveLength(1)
        expect(evidence.modules.filter(url => url.includes(`/packages/core/${pkg}/lib/`))).toEqual([])
      }
      const calls = evidence.events.filter(event => event.type === 'tool/call')
      expect(calls).toHaveLength(1)
      expect(calls[0]!.data).toMatchObject({
        callId: 'cli-smoke-call', name: process.platform === 'win32' ? 'pwsh' : 'bash',
      })
      const results = evidence.events.filter(event => event.type === 'tool/result')
      expect(results).toHaveLength(1)
      const toolResult = results[0]!.data
      const message = toolResult.message
      expect(message).toMatchObject({ role: 'tool', toolCallId: 'cli-smoke-call' })
      if (toolResult.error !== undefined) {
        expect(toolResult.error).toMatchObject({ name: 'SandboxUnavailableError', code: 'SANDBOX_UNAVAILABLE' })
        expect(message.isError).toBe(true)
      } else {
        expect(message.isError).not.toBe(true)
        expect(message.content.filter(part => part.type === 'text').map(part => part.text).join(''))
          .toContain('CLI_TOOL_ROUND_TRIP')
      }
      expect(evidence.events.filter(event => event.type === 'turn/end').map(event => event.data.reason))
        .toEqual([{ kind: 'completed' }])
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }, sourceToolTimeoutMs)
})
