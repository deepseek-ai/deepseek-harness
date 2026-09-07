/** Cold catalog observations of persisted fork children with tool-heavy inherited histories. */

import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SessionQueryEngine from '@deepseek-ai/dsh-session-query'
import SubagentRuntime, { SUBAGENT_DESCRIPTOR_VERSION } from '@deepseek-ai/dsh-subagent'
import { assertBuiltBenchmarkRuntime } from '../support/built-worker.ts'
import { PARENT_ID, syntheticHistory, TIME_ZERO, WORKLOAD } from './workload.ts'

/** Two complete catalog reads in one fresh Host, with every child observation released. */
export interface CatalogReport {
  readonly totalMs: number
  readonly firstMs: number
  readonly repeatMs: number
  readonly cpuUserMs: number
  readonly cpuSystemMs: number
  readonly children: number
  readonly peakRssMb: number
}

class CatalogQuery extends SessionQueryEngine {
  override searchSessions(): Promise<never> {
    return Promise.reject(new Error('search is outside the child-catalog benchmark'))
  }
  override searchEvents(): Promise<never> {
    return Promise.reject(new Error('search is outside the child-catalog benchmark'))
  }
}

async function seed(ctx: Context): Promise<void> {
  const inherited = syntheticHistory(WORKLOAD.childHistoryTurns)
  for (let child = 0; child < WORKLOAD.children; child++) {
    const id = SessionId('bench-child-' + String(child))
    const events: SessionEvent[] = [
      ...inherited,
      { type: 'session/end-seed', seq: SessionSeq(inherited.length), time: TIME_ZERO + inherited.length, data: { inherited: true } },
      { type: 'subagent/descriptor', seq: SessionSeq(inherited.length + 1), time: TIME_ZERO + inherited.length + 1, data: {
        version: SUBAGENT_DESCRIPTOR_VERSION, mode: 'continuable', provider: 'fork', label: 'Synthetic child ' + String(child),
      } },
    ]
    const handle = await ctx.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION, id, createdAt: TIME_ZERO + child, cwd: '/bench',
      parentSession: PARENT_ID, isSeeded: true, origin: 'subagent', delegationDepth: 1,
    }, { inheritedEventCount: SessionLogOffset(inherited.length) })
    try {
      await handle.append(events)
      await handle.flush()
    } finally { await handle.close() }
  }
}

async function run(root: string, mode: string): Promise<CatalogReport | { seeded: true }> {
  const ctx = new Context()
  try {
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(JsonlSessionPersistence, { root, compression: 'zstd' })
    await ctx.plugin(CatalogQuery)
    await ctx.plugin(SubagentRuntime)
    if (mode === 'seed') {
      await seed(ctx)
      return { seeded: true }
    }
    const cpuStart = process.cpuUsage()
    const start = performance.now()
    const first = await ctx.subagents.listChildren(PARENT_ID)
    const firstDone = performance.now()
    const repeated = await ctx.subagents.listChildren(PARENT_ID)
    const end = performance.now()
    const cpu = process.cpuUsage(cpuStart)
    if (first.length !== WORKLOAD.children || repeated.length !== WORKLOAD.children
      || [...first, ...repeated].some(row => row.kind !== 'child')) {
      throw new Error('child-catalog benchmark did not reach the complete healthy catalog')
    }
    return {
      totalMs: end - start, firstMs: firstDone - start, repeatMs: end - firstDone,
      cpuUserMs: cpu.user / 1_000, cpuSystemMs: cpu.system / 1_000,
      children: first.length, peakRssMb: process.resourceUsage().maxRSS / 1_024,
    }
  } finally { await ctx.fiber.dispose() }
}

assertBuiltBenchmarkRuntime(import.meta.url, Object.fromEntries([
  '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-session-query',
  '@deepseek-ai/dsh-session-persistence-jsonl',
].map(name => [name, import.meta.resolve(name)])))
const [root, mode] = process.argv.slice(2)
if (root === undefined || (mode !== 'seed' && mode !== 'catalog')) {
  throw new Error('usage: child-catalog.worker.js <root> <seed|catalog>')
}
process.stdout.write(JSON.stringify(await run(root, mode)) + '\n')
