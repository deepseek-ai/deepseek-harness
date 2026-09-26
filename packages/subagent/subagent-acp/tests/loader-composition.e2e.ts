import { realpathSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

/**
 * Keyless REAL-composition coverage for the ACP provider through a test-only
 * patch file: parent-session cwd inheritance and model-visible failure detail
 * both cross the Loader, subprocess, ACP, tool, and persisted-session paths.
 * The with-key tier lives in subagent-acp.e2e.ts.
 */

const driver = fileURLToPath(new URL(
  './fixtures/loader/driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  './fixtures/loader/acp.patch.yml',
  import.meta.url,
))
const mockServer = fileURLToPath(new URL('./mock-acp-server.ts', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

async function jsonlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const paths = await Promise.all(entries.map(async (entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return jsonlFiles(path)
    return entry.isFile() && entry.name.endsWith('.jsonl') ? [path] : []
  }))
  return paths.flat()
}

function toolResultText(events: SessionEvent[]): string {
  const results = events.filter(event => event.type === 'tool/result')
  expect(results).toHaveLength(1)
  return results[0]!.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('ACP subagent cwd inheritance through the production profile', () => {
  it('runs the child in the parent session workspace and announces it as the ACP session cwd', async () => {
    let events: SessionEvent[] = []
    let workspace = ''
    const { stderr } = await runLoaderSmoke({
      label: 'acp-subagent cwd composition smoke',
      tempDirPrefix: 'acp-subagent-cwd-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      env: { DSH_TEST_MOCK_ACP_SERVER: mockServer },
      inspect: async (cwd) => {
        // The child reports realpaths; canonicalize the temp workspace to match.
        workspace = realpathSync(cwd)
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')

    // The tool result carries the child's two-line echo: its real process.cwd()
    // and the cwd the backend announced in `session/new` — both the parent
    // session's workspace, never the harness process's launch directory.
    expect(toolResultText(events)).toBe(`${workspace}\n${workspace}`)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('presents the ACP remote-limit diagnostic separately from partial output', async () => {
    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'acp-subagent diagnostic composition smoke',
      tempDirPrefix: 'acp-subagent-diagnostic-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      env: {
        DSH_TEST_MOCK_ACP_SERVER: mockServer,
        DSH_TEST_ACP_MODE: 'diagnostic',
      },
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(toolResultText(events)).toBe(
      'Error: subagent run failed\n'
      + 'Diagnostic: Subagent failure (provider: ACP; stage: prompt; category: remote-limit; stop reason: max_turn_requests)\n'
      + 'Partial output before the run ended:\npartial loader answer',
    )
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
