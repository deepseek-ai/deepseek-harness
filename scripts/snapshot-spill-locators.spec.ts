import { Context } from '@deepseek-ai/cordis'
import { LocalSpillStore } from '@deepseek-ai/dsh-spill-local'
import { LocalFileSystem } from '@deepseek-ai/dsh-fs-local'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import * as locators from './snapshot-spill-locators.ts'

it.each([false, true])('keeps concurrent physical spill files private while retaining logical locator length and bytes (reverse allocation=%s)', async (reverseAllocation) => {
  const roots: string[] = []
  const disposers: (() => Promise<void>)[] = []
  const secondAllocated = Promise.withResolvers<undefined>()
  try {
    const runs = await Promise.all([0, 1].map(async (index) => {
      if (reverseAllocation && index === 0) await secondAllocated.promise
      const root = await mkdtemp(join(tmpdir(), 'snapshot-locator-'))
      roots.push(root)
      if (index === 1) secondAllocated.resolve(undefined)
      const ctx = new Context()
      const storeFiber = ctx.plugin(LocalSpillStore, { root, cleanupPeriodDays: 0 })
      disposers.push(() => storeFiber.dispose())
      await storeFiber
      const fsFiber = ctx.plugin(LocalFileSystem, { cwd: root })
      disposers.push(() => fsFiber.dispose())
      await fsFiber


      const locatorRoot = resolve('/tmp/dsh-acp-snap-123456789')
      const fork = ctx.plugin(locators, { root, locatorRoot })
      disposers.push(() => fork.dispose())
      await fork
      const content = `physical UTF-8 内容 ${index}`
      const ref = await ctx.spillStore.saveText({
        owner: { sessionId: SessionId('same-session') },
        source: { kind: 'tool', toolName: 'bash', callId: ToolCallId('same-call'), label: 'result' },
        suggestedName: 'bash.txt', content,
      })
      expect(ref.bytes).toBe(Buffer.byteLength(content))
      expect(ref.locator.startsWith(locatorRoot)).toBe(true)
      const target = await ctx.fs.resolve(ref.locator)
      expect(target.displayPath).toBe(ref.locator)
      const physicalPath = ctx.fs.processPath(target)
      expect(physicalPath.startsWith(await realpath(root))).toBe(true)
      expect(await readFile(physicalPath, 'utf8')).toBe(content)
      expect(await ctx.fs.readText(target)).toBe(content)
      await expect(ctx.fs.resolve(join(locatorRoot, 'missing.txt'))).rejects.toThrow('not saved by this run')
      const ordinary = join(root, 'ordinary.txt')
      await writeFile(ordinary, 'ordinary')
      expect(await ctx.fs.readText(await ctx.fs.resolve(ordinary))).toBe('ordinary')
      await fork.dispose()
      const restored = await ctx.fs.resolve(ref.locator)
      expect(ctx.fs.processPath(restored)).not.toBe(physicalPath)
      expect(await ctx.fs.stat(restored)).toBeUndefined()
      return { root, physicalPath, locator: ref.locator, content }
    }))
    expect(runs[0]?.physicalPath).not.toBe(runs[1]?.physicalPath)
    expect(runs[0]?.locator.length).toBe(runs[1]?.locator.length)
    // Promise.all preserves input order; allocation completion order may differ.
    await rm(runs[0]!.root, { recursive: true, force: true })
    expect(await readFile(runs[1]?.physicalPath as string, 'utf8')).toBe(runs[1]?.content)
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })))
  }
})
