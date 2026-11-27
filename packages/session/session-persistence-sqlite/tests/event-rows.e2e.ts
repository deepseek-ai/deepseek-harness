/**
 * REAL-composition proof: the shipped headless profile with the SQLite provider in place of JSONL stores one
 * agent turn as event rows, and the per-Session views answer for it from another connection.
 */
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const driver = fileURLToPath(new URL('./fixtures/loader/driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL('./fixtures/loader/event-rows.patch.yml', import.meta.url))
const repoTsconfig = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe('SQLite persistence through the production headless profile', () => {
  it('stores a tool-calling turn as event rows that SQL can query by Session', async () => {
    let answers: Record<string, unknown[]> = {}
    let files: string[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'sqlite event rows headless smoke',
      tempDirPrefix: 'sqlite-event-rows-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        files = (await readdir(join(cwd, '.sessions'), { recursive: true })).filter(name => name.includes('.jsonl'))
        const db = new DatabaseSync(join(cwd, '.sessions', '.segments', 'sessions.sqlite'), { readOnly: true })
        const all = (sql: string): unknown[] => db.prepare(sql).all().map(row => ({ ...row }))
        try {
          answers = {
            version: all('PRAGMA user_version'),
            sessions: all('SELECT count(*) AS sessions, min(event_count) > 0 AS stored FROM session_summary'),
            calls: all('SELECT provider, model, input_tokens, output_tokens, cache_read_tokens, reasoning_tokens FROM session_llm_calls ORDER BY seq'),
            tools: all('SELECT tool, is_error, result_seq > seq AS answered, duration_ms >= 0 AS timed FROM session_tools'),
            efforts: all("SELECT data ->> 'reasoningEffort' AS effort FROM session_events WHERE type = 'model/selection' ORDER BY seq DESC LIMIT 1"),
            turns: all("SELECT data ->> '$.reason.kind' AS outcome FROM session_events WHERE type = 'turn/end'"),
            behind: all('SELECT count(*) AS behind FROM derivations WHERE cursor IS NOT NULL'),
            unreadable: all("SELECT count(*) AS rows FROM session_events WHERE (codec = 0) != (typeof(data) = 'text')"),
          }
        } finally { db.close() }
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(files).toEqual([])
    expect(answers).toEqual({
      version: [{ user_version: 3 }],
      sessions: [{ sessions: 1, stored: 1 }],
      calls: [
        { provider: 'cli-mock', model: 'cli-mock', input_tokens: 11, output_tokens: 3, cache_read_tokens: 2, reasoning_tokens: null },
        { provider: 'cli-mock', model: 'cli-mock', input_tokens: 7, output_tokens: 5, cache_read_tokens: null, reasoning_tokens: 1 },
      ],
      tools: [{ tool: process.platform === 'win32' ? 'pwsh' : 'bash', is_error: 0, answered: 1, timed: 1 }],
      efforts: [{ effort: 'off' }],
      turns: [{ outcome: 'completed' }],
      behind: [{ behind: 0 }],
      unreadable: [{ rows: 0 }],
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)

  it('archives and reopens a recorded turn without changing its history or tool queries', async () => {
    await runLoaderSmoke({
      label: 'sqlite cold archive headless smoke',
      tempDirPrefix: 'sqlite-cold-archive-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      env: { DSH_TEST_COLD: '1' },
    })
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
