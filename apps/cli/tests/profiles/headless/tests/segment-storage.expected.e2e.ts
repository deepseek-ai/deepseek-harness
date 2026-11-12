/** Production profile integration for JSONL preservation and SQLite Segment branching. @module */
import { DatabaseSync } from 'node:sqlite'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { expect, it, onTestFinished } from 'vitest'
import { z } from 'zod'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import { generationLogPath } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'

const proof = z.object({ cut: z.number().optional(),
  results: z.array(z.object({ id: z.string(), route: z.string(), runtime: z.string(), output: z.string() })),
  toolRuns: z.array(z.object({ id: z.string(), value: z.string() })),
  refusals: z.array(z.object({ name: z.string(), message: z.string() })),
})

it('uses the shipped storage plugin for legacy import, Segment branching and restart without changing the Agent loop', async () => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'dsh-segment-profile-')))
  onTestFinished(() => rm(cwd, { recursive: true, force: true }))
  const root = join(cwd, 'sessions'), database = join(root, '.segments', 'sessions.sqlite')
  const run = async (stage: 'legacy' | 'seed' | 'branch' | 'resume' | 'failure', cut?: number) => {
    const report = join(cwd, `${stage}.json`), configPath = join(cwd, `${stage}.patch.json`)
    await writeFile(configPath, JSON.stringify([
      { id: 'headless-runner', disabled: true }, { id: 'llm-deepseek', disabled: true }, { id: 'session-title-llm', disabled: true },
      { id: 'agent-default-model', config: { provider: 'segment-test', model: 'segment-test' } },
      { id: 'session-persistence-jsonl', config: { root, compression: 'none' } },
      { insert: [{ id: 'segment-driver', name: fileURLToPath(new URL('./fixtures/segment-driver.ts', import.meta.url)),
        config: { report, stage, mock: true, ...cut === undefined ? {} : { cut } } }] },
    ]))
    const child = await runLoaderSmoke({ label: `Segment storage ${stage}`, cwd, configPath,
      binScript: fileURLToPath(new URL('../../../../src/bin.ts', import.meta.url)), sourceImport: 'tsx/esm',
      tsconfigPath: fileURLToPath(new URL('../../../../../../tsconfig.json', import.meta.url)),
      binArgs: ['headless', '--patch', configPath, 'Verify production Session persistence.'],
      processTimeoutMs: 60_000, env: { DEEPSEEK_API_KEY: undefined },
    })
    const stderr = child.stderr.replace(/\r\n/g, '\n')
      .replace(/^\(node:\d+\) ExperimentalWarning: SQLite[^\n]*\n(?:\(Use[^\n]*\n)?/gm, '')
    expect(stderr).toBe('')
    const data = proof.parse(JSON.parse(await readFile(report, 'utf8')))
    expect(data.results.every(item => item.runtime === 'ReactLoopAgent')).toBe(true)
    return data
  }
  const legacy = await run('legacy'), old = legacy.toolRuns[0]?.value
  // Stage a released JSONL artifact from the completed fixture Session after its process exits.
  const initial = new DatabaseSync(database)
  let oldPrefix: string
  try {
    const header = z.string().parse(initial.prepare('SELECT header FROM traces WHERE trace_uuid = ?').get('legacy-chat')?.header)
    const events = initial.prepare('SELECT payload FROM events ORDER BY seq').all().map(row => z.string().parse(row.payload))
    oldPrefix = [header, ...events].join('\n') + '\n'
  } finally { initial.close() }
  await rm(join(root, '.segments'), { recursive: true })
  const oldFile = generationLogPath(root, cwd, SessionId('legacy-chat'), SESSION_FORMAT_VERSION, 'none')
  await mkdir(join(oldFile, '..'), { recursive: true }); await writeFile(oldFile, oldPrefix)
  const seeded = await run('seed'), [first, second] = seeded.toolRuns.map(item => item.value)
  expect(seeded.results.map(item => item.route)).toEqual(['sqlite', 'sqlite', 'sqlite'])
  expect(seeded.results[0]?.output).toBe(old)
  if (seeded.cut === undefined) throw new Error('Missing retained event offset')
  const inspect = new DatabaseSync(database)
  const original = inspect.prepare('SELECT segment_uuid, seq, payload FROM events ORDER BY segment_uuid, seq').all()
  inspect.close()
  const branch = await run('branch', seeded.cut), [side, continued] = branch.toolRuns.map(item => item.value)
  expect(branch.results.map(item => item.output)).toEqual([first, side, second, continued, side])
  const restored = await run('resume')
  expect(restored.results.map(item => item.route)).toEqual(['sqlite', 'sqlite', 'sqlite', 'sqlite'])
  expect(restored.results.slice(0, 3).map(item => item.output)).toEqual([old, continued, side])
  expect(restored.toolRuns.map(item => item.id)).toEqual(['post-restart'])
  expect(await readFile(oldFile, 'utf8')).toEqual(oldPrefix)
  const db = new DatabaseSync(database)
  try {
    for (const event of original) {
      expect(db.prepare('SELECT payload FROM events WHERE segment_uuid = ? AND seq = ?').get(event.segment_uuid!, event.seq!))
        .toMatchObject({ payload: event.payload })
    }
    expect(db.prepare('SELECT count(*) AS n FROM segments').get()).toMatchObject({ n: 4 })
    db.prepare('UPDATE traces SET header = ? WHERE trace_uuid = ?').run('{invalid', 'source-chat')
  } finally { db.close() }
  const failure = await run('failure')
  expect(failure.refusals).toHaveLength(1)
  expect(failure.results[0]?.output).toBe(old)
  expect((await readdir(root, { recursive: true })).some(name => name.includes('source-chat') && name.endsWith('.jsonl'))).toBe(false)
}, 180_000)
