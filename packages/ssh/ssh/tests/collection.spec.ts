/** Collected output remains byte-addressable and recoverable across transport lag and helper teardown. */
import { createHash } from 'node:crypto'
import { readFile, rm } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { SshSubprocessRuntime } from '@deepseek-ai/dsh-subprocess-ssh'
import { createHelperHarness } from './fixtures/helper.ts'
import { doneSchema, preparedSchema } from '../src/schemas.ts'
import { z } from 'zod'

const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

describe.skipIf(process.platform === 'win32')('SSH collected output', () => {
  it('captures the full stream while the snapshot reader is paused and retains its spill after disconnect', async () => {
    const helper = await createHelperHarness()
    let spill: string | undefined
    try {
      const payload = 'abcdef'.repeat(12000)
      const prepared = await helper.client.request('process.prepare', {
        argv: [process.execPath, '-e', `process.stdout.write(${JSON.stringify(payload)})`], cwd: helper.root, graceMs: 500,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 16, spill: { maxBytes: 100000 } }, stderr: 'pipe' },
      }, preparedSchema)
      const output = await helper.connectStream(prepared.streams.stdout!)
      const error = await helper.connectStream(prepared.streams.stderr!)
      error.end()
      error.resume()
      expect(output.readableFlowing).toBe(false)
      await helper.client.request('process.start', { id: prepared.id }, z.object({}).strict())
      const completed = await helper.client.request('process.done', { id: prepared.id }, doneSchema)
      expect(completed.outcome.exitCode).toBe(0)
      expect(completed.collected.stdout?.totalBytes).toBe(Buffer.byteLength(payload))
      expect(Buffer.from(completed.collected.stdout!.tail, 'base64').toString()).toBe(payload.slice(-16))
      expect(await helper.client.request('process.wait', { id: prepared.id }, z.boolean())).toBe(true)
      spill = completed.spills.stdout
      expect(spill).toBeDefined()
      await helper.close()
      expect(digest(await readFile(spill!))).toBe(digest(Buffer.from(payload)))
    } finally {
      await helper.close()
      if (spill !== undefined) await rm(spill, { force: true })
    }
  }, 15_000)

  it('uses raw byte offsets for the final tail and exposes the complete remote spill', async () => {
    const helper = await createHelperHarness()
    const ctx = new Context()
    ctx.provide('ssh', helper.connection as never)
    const fiber = await ctx.plugin(SshSubprocessRuntime)
    let spill: string | undefined
    try {
      const bytes = Buffer.from([0x61, 0x62, 0x63, 0x64, 0xff, 0x65, 0x66, 0x67])
      const handle = ctx.subprocess.spawn({
        argv: [process.execPath, '-e', `process.stdout.write(Buffer.from(${JSON.stringify([...bytes])}))`], cwd: helper.root, graceMs: 500,
        stdio: { stdin: 'ignore', stdout: { maxBytes: 4, spill: { maxBytes: 16 } }, stderr: { maxBytes: 8 } },
      })
      expect(await handle.done).toEqual({ exitCode: 0, signal: null })
      expect(await handle.waitForExit()).toBe(true)
      const tail = handle.collected.stdout!.readFrom(0)
      expect(tail).toMatchObject({ text: '\ufffdefg', nextOffset: 8, lossy: true })
      expect(handle.collected.stdout!.readFrom(7)).toMatchObject({ text: 'g', nextOffset: 8, lossy: false })
      spill = tail.spillPath
      expect(await readFile(spill!)).toEqual(bytes)
      expect(handle.collected.stderr!.readFrom(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    } finally {
      await fiber.dispose()
      await helper.close()
      if (spill !== undefined) await rm(spill, { force: true })
    }
  }, 15_000)
})
