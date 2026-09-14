import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { logTruncationMarker } from '../src/protocol.ts'

// Keep the interpreter and pipe lifecycle real; only OS-dependent read sizes
// change. Each byte reaches the runtime as its own data event.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawn: vi.fn(actual.spawn).mockImplementation((...args) => {
      const child = actual.spawn(...args)
      const stdout = child.stdout!
      const emit = stdout.emit.bind(stdout)
      stdout.emit = (event: string | symbol, ...values: unknown[]) => {
        if (event !== 'data') return emit(event, ...values)
        const chunk = values[0] as Buffer
        for (let offset = 0; offset < chunk.length; offset++) {
          emit('data', chunk.subarray(offset, offset + 1))
        }
        return true
      }
      return child
    }),
  }
})

const { PythonPtcRuntime } = await import('../src/index.ts')

it('seals stray fragments without recopying the sealed prefix', async () => {
  const ctx = new Context()
  const fiber = await ctx.plugin(PythonPtcRuntime, { maxLogBytes: 200_000, maxWallMs: 30_000 })
  const realConcat = Buffer.concat.bind(Buffer)
  let copied = 0
  let maxFragments = 0
  const concat = vi.spyOn(Buffer, 'concat').mockImplementation((list, total) => {
    maxFragments = Math.max(maxFragments, list.length)
    for (const part of list) copied += part.length
    return realConcat(list, total)
  })
  try {
    const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
      program: 'import os\nos.write(1, b"x" * 60000 + b"\\n")\nreturn "done"',
      bindings: [],
    }))
    expect(result.error).toBeUndefined()
    expect(result.value).toBe('done')
    expect(result.logs).toEqual(['x'.repeat(60_000)])
    // Sealing copies each byte at most twice; merging every accumulated prefix
    // instead copies over a megabyte for these 60,001 controlled fragments.
    expect(maxFragments).toBeLessThanOrEqual(1024)
    expect(copied).toBeLessThan(256 * 1024)
  } finally {
    concat.mockRestore()
    await fiber.dispose()
  }
}, 40_000)

it.each([
  { name: 'illegal UTF-8 bytes', payload: 'b"\\xff" * 3200' },
  { name: 'CESU-8 lone surrogates', payload: 'b"\\xed\\xa0\\x80" * 1100' },
])('bounds $name by their U+FFFD-decoded cost', async ({ payload }) => {
  const ctx = new Context()
  const fiber = await ctx.plugin(PythonPtcRuntime, { maxLogBytes: 3072, maxWallMs: 30_000 })
  const realConcat = Buffer.concat.bind(Buffer)
  let maxConcat = 0
  const concat = vi.spyOn(Buffer, 'concat').mockImplementation((list, total) => {
    const merged = realConcat(list, total)
    maxConcat = Math.max(maxConcat, merged.length)
    return merged
  })
  try {
    const result = await ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({
      program: `import os\nos.write(1, ${payload})\nreturn None`,
      bindings: [],
    }))
    expect(result.error).toBeUndefined()
    expect(result.logs.at(-1)).toBe(logTruncationMarker(3072))
    // Each raw byte decodes to U+FFFD (three UTF-8 bytes), so a 3072-byte
    // budget flushes near 1024 raw bytes. Charging raw or structural widths
    // instead retains over 2048 bytes before flushing these payloads.
    expect(maxConcat).toBeLessThan(2048)
  } finally {
    concat.mockRestore()
    await fiber.dispose()
  }
}, 20_000)
