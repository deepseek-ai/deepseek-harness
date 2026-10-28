import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { decodeGoalChange } from '@deepseek-ai/dsh-goal'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const binScript = fileURLToPath(new URL('../../../test-support/loader-smoke/tests/fixtures/headless-driver.ts', import.meta.url))
const configPath = fileURLToPath(new URL(
  './fixtures/domain/goal.patch.yml',
  import.meta.url,
))
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

describe('goal domain through the production headless profile and process', () => {
  it('persists the Loader-mounted snapshot without starting a goal round', async () => {
    let events: SessionEvent[] = []
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'goal-domain',
      tempDirPrefix: 'goal-domain-e2e-',
      binScript,
      libBinScript: binScript,
      configPath,
      binArgs: [configPath, 'prove the persisted goal domain'],
      tsconfigPath: repoTsconfig,
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).toBe('')
    const result = JSON.parse(stdout.trimEnd().split('\n').at(-1) ?? '') as Record<string, unknown>
    expect(result).toMatchObject({
      type: 'result',
    })
    expect(result['output']).toBeTypeOf('string')
    expect(result['output']).toContain('CLI tool round trip complete')
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(1)
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(1)

    const changes = events.filter(event => event.type === 'goal/change')
    expect(changes).toHaveLength(1)
    const context = changes[0]
    if (context?.type !== 'goal/change') throw new Error('expected goal change event')
    const change = decodeGoalChange(context.data)
    if (change === undefined) throw new Error('expected durable goal change')
    expect(change).toMatchObject({
      operation: 'create',
      roundsStarted: 0,
      goal: {
        revision: 1,
        objective: 'Prove the composed goal survives in the session log',
        phase: 'active',
        maxGoalRounds: 7,
      },
    })
    expect(JSON.stringify(context)).not.toContain('activation')
    // No admitted continuation round ran; the goal change itself is independent
    // from model-visible user messages.
    expect(events.filter(event => event.type === 'user/message'
      && event.data.source.kind === 'goal' && event.data.source.round > 0)).toHaveLength(0)
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
