/** Threshold-free, built-runtime measurements of historical catalog reads as the corpus grows. */

import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const CHILDREN = 4
const CHILD_EVENTS = 1_000
const SAMPLES = 3

async function measure(unrelated: number) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-catalog-perf-'))
  const ctx = new Context()
  try {
    for (let i = 0; i < unrelated + CHILDREN + 1; i++) {
      const id = i === 0 ? 'parent' : `session-${i}`
      const child = i > 0 && i <= CHILDREN
      const directory = join(root, '_no-cwd', id)
      await mkdir(directory, { recursive: true })
      const header = { type: 'session', version: 3, id, createdAt: i + 1, isSeeded: false, delegationDepth: child ? 1 : 0,
        ...(child ? { origin: 'subagent', parentSession: 'parent' } : {}) }
      const events = child ? [
        { type: 'subagent/descriptor', seq: 0, time: 1, data: { version: 3, mode: 'one-shot', provider: 'spawn' } },
        ...Array.from({ length: CHILD_EVENTS - 1 }, (_, seq) => ({
          type: 'feedback/record', seq: seq + 1, time: 2, data: { text: 'Synthetic migration observation. '.repeat(4) },
        })),
      ] : []
      await writeFile(join(directory, 'session.v3.jsonl'), [header, ...events].map(row => JSON.stringify(row) + '\n').join(''))
    }
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'none' })
    const parent = SessionId('parent')
    const timed = async (operation: () => Promise<unknown>): Promise<number> => {
      const start = performance.now()
      await operation()
      return performance.now() - start
    }
    const read = async (): Promise<void> => {
      const handle = await ctx.sessionPersistence.open(parent, 'read')
      try { await handle.read() } finally { await handle.close() }
    }
    const statMs = await timed(() => ctx.sessionPersistence.stat(parent))
    const coldReadMs = await timed(read)
    const memoReadMs = await timed(read)
    const publishMs = await timed(async () => {
      const handle = await ctx.sessionPersistence.open(parent, 'write')
      await handle.close()
    })
    const currentReadMs = await timed(read)
    return { unrelated, children: CHILDREN, childEvents: CHILD_EVENTS, statMs, coldReadMs, memoReadMs, publishMs, currentReadMs }
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
}

if (process.argv[2] === '--sample') {
  process.stdout.write(JSON.stringify(await measure(Number(process.argv[3]))) + '\n')
} else {
  const samples = []
  for (const size of [0, 100, 1_000]) {
    for (let sample = 0; sample < SAMPLES; sample++) {
      const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--sample', String(size)], {
        encoding: 'utf8', timeout: 60_000,
      })
      if (result.error !== undefined) throw result.error
      if (result.signal !== null || result.status !== 0) throw new Error(`measurement failed: ${result.signal ?? result.status}: ${result.stderr}`)
      samples.push(JSON.parse(result.stdout) as Record<string, number>)
    }
  }
  process.stdout.write(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, samples }, null, 2) + '\n')
}
