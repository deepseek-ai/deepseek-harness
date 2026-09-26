import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { type SessionEvent } from '@deepseek-ai/dsh-session'
import { LOADER_SMOKE_TEST_TIMEOUT_MS, runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

// Keep the Loader config under examples so both modes exercise the same deployable
// topology: local fixture source plus bare plugins owned by the examples workspace.
const driver = fileURLToPath(new URL(
  './fixtures/driver.ts',
  import.meta.url,
))
const configPath = fileURLToPath(new URL(
  './fixtures/time-context.patch.yml',
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

describe('time-context through the production headless profile', () => {
  it('uses the process zone and throttles context across turns by default', async () => {
    let events: SessionEvent[] = []
    const { stderr } = await runLoaderSmoke({
      label: 'time-context headless smoke',
      tempDirPrefix: 'time-context-e2e-',
      binScript: driver,
      libBinScript: driver,
      configPath,
      tsconfigPath: repoTsconfig,
      env: { TZ: 'Asia/Shanghai' },
      inspect: async (cwd) => {
        const logs = await jsonlFiles(join(cwd, '.sessions'))
        expect(logs).toHaveLength(1)
        const lines = (await readFile(logs[0] as string, 'utf8')).trimEnd().split('\n')
        events = lines.slice(1).map(line => JSON.parse(line) as SessionEvent)
      },
    })
    expect(stderr).not.toContain('UNHANDLED')
    expect(events.filter(event => event.type === 'turn/end')).toHaveLength(2)

    const contexts = events.filter(
      (event): event is SessionEvent<'user/message'> => event.type === 'user/message'
        && event.data.source.kind === 'time-context')
    const starts = events.filter(event => event.type === 'step/start')
    expect(contexts).toHaveLength(1)
    expect(starts).toHaveLength(2)
    for (let index = 0; index < contexts.length; index += 1) {
      expect(contexts[index]!.seq).toBeGreaterThan(starts[index]!.seq)
      expect(contexts[index]!.surfaceOp).toBe('append')
      // `snapshot` form: one named contribution whose text is exactly what the
      // model read, so a consumer attributes it without re-splitting prose.
      expect(contexts[index]!.data.source).toMatchObject({
        kind: 'time-context',
        form: 'snapshot',
        sections: [{ name: 'time-context' }],
      })
    }
    const contextText = contexts.map(event => event.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('\n'))
    expect(contextText[0]).toMatch(
      /Time sampled while preparing turn 1, step 1: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+08:00\[Asia\/Shanghai\]/,
    )
    expect(contextText[0]).toContain('Elapsed since the preceding model-visible message: unavailable.')

    const headers = events.filter(event => event.type === 'request/header')
    expect(JSON.stringify(headers)).not.toContain('Time sampled while preparing')
  }, LOADER_SMOKE_TEST_TIMEOUT_MS)
})
