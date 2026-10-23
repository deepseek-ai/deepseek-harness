/**
 * Threshold-free measurement of one `deleteInactive` call over the default
 * whole-unit JSON medium. Seeds the medium by writing the unit file directly
 * (seeding through the API would publish the growing file once per row), then
 * boots the production plugin and times the removal, the whole-unit publish it
 * triggers, and the batch-call count the storage layer sees.
 */

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import Storage from '@deepseek-ai/dsh-storage'
import type { StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionStore from '@deepseek-ai/dsh-session'
import ScheduleService from '../src/index.ts'
import { createAfterScheduleRecord, createEveryScheduleRecord, ScheduleId } from '../src/domain.ts'

interface Args {
  ended: number
  active: number
  mode: 'batch' | 'per-row'
}

function parseArgs(argv: readonly string[]): Args {
  const value = (name: string, fallback: number): number => {
    const entry = argv.find(argument => argument.startsWith(`--${name}=`))
    if (entry === undefined) return fallback
    const parsed = Number(entry.slice(name.length + 3))
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`--${name} must be a non-negative integer`)
    return parsed
  }
  const mode = argv.find(argument => argument.startsWith('--mode='))?.slice('--mode='.length) ?? 'batch'
  if (mode !== 'batch' && mode !== 'per-row') throw new Error('--mode must be batch or per-row')
  return { ended: value('ended', 500_000), active: value('active', 500_000), mode }
}

/** Serialized schedule unit with the requested ended and active rows. */
function seedText(ended: number, active: number): string {
  const now = Date.now()
  const tasks: Record<string, unknown> = {}
  for (let index = 0; index < ended; index += 1) {
    const id = `ended-${index}`
    tasks[id] = {
      sessionId: `ended-session-${index}`,
      record: createAfterScheduleRecord(ScheduleId(id), `Ended ${index}`, 60, now - 5 * 60_000, `Ended ${index}`),
      status: 'inactive',
    }
  }
  for (let index = 0; index < active; index += 1) {
    const id = `active-${index}`
    tasks[id] = {
      sessionId: `active-session-${index}`,
      record: createEveryScheduleRecord(ScheduleId(id), `Active ${index}`, 3_600, now, `Active ${index}`),
      status: 'active',
    }
  }
  return JSON.stringify({ unit: { name: 'schedule', version: 1 }, global: null, tables: { tasks } })
}

/** Backend façade counting how many deletions reach the medium. */
function counted(inner: StorageBackend): {
  backend: StorageBackend
  batches: () => number
  singles: () => number
} {
  let batches = 0
  let singles = 0
  const kv = inner.kv
  if (kv === undefined) throw new Error('json backend is missing its kv facet')
  return {
    batches: () => batches,
    singles: () => singles,
    backend: {
      close: () => inner.close(),
      kv: {
        open: async (descriptor) => {
          const unit = await kv.open(descriptor)
          const backup = unit.backupRecord?.bind(unit)
          return {
            loadAll: () => unit.loadAll(),
            putRecord: (table, key, value) => unit.putRecord(table, key, value),
            deleteRecord: async (table, key) => {
              singles += 1
              await unit.deleteRecord(table, key)
            },
            deleteRecords: async (table, keys) => {
              batches += 1
              await unit.deleteRecords(table, keys)
            },
            setGlobal: value => unit.setGlobal(value),
            close: () => unit.close(),
            ...(backup === undefined ? {} : { backupRecord: backup }),
          }
        },
      },
    },
  }
}

async function measure(args: Args) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schedule-clear-perf-'))
  try {
    const path = join(root, 'schedule.json')
    const seedStart = performance.now()
    await writeFile(path, seedText(args.ended, args.active))
    const seedMs = performance.now() - seedStart
    const seedBytes = (await stat(path)).size

    const json = new JsonStorageBackend(root)
    const { backend, batches, singles } = counted(json)
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(Storage)
    ctx.effect(() => ctx.storage.backend.register('fixture', backend))
    const facility = new DomainFacility(ctx, { backend: 'fixture' })
    ctx.effect(() => {
      const unmount = ctx.storage.mount('domain', facility)
      ctx.provide('storageDomain', facility)
      return async () => {
        await facility.closeAll()
        unmount()
      }
    })
    ctx.provide('sessionController', {
      resolveAgent: async () => { throw new Error('perf measurement does not activate Sessions') },
    } as never)
    ctx.provide('sessionPersistence', {} as never)
    ctx.on('session/flush', async () => {})

    const openStart = performance.now()
    await ctx.plugin(ScheduleService, {})
    const openMs = performance.now() - openStart
    const start = performance.now()
    const result = args.mode === 'batch'
      ? await ctx.schedule.deleteInactive()
      : await (async () => {
        const table = facility.get('schedule')?.table('tasks')
        if (table === undefined) throw new Error('schedule domain is not open')
        for (let index = 0; index < args.ended; index += 1) {
          await table.delete(ScheduleId(`ended-${index}`))
        }
        return { deleted: args.ended }
      })()
    const deleteMs = performance.now() - start
    const afterBytes = (await stat(path)).size
    const rss = process.memoryUsage().rss / (1024 * 1024)
    await ctx.fiber.dispose()
    return {
      node: process.version,
      platform: `${process.platform}-${process.arch}`,
      ended: args.ended,
      active: args.active,
      mode: args.mode,
      seedMs: Math.round(seedMs),
      seedBytes,
      openMs: Math.round(openMs),
      deleteMs: Math.round(deleteMs),
      afterBytes,
      deleted: result.deleted,
      deleteRecordsCalls: batches(),
      deleteRecordCalls: singles(),
      rssMB: Math.round(rss),
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

process.stdout.write(`${JSON.stringify(await measure(parseArgs(process.argv.slice(2))), null, 2)}\n`)
