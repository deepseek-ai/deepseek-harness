/** Explicit opt-in real SenseVoice inference, including the managed runtime when no overrides are supplied. */
import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import LocalSubprocess from '@deepseek-ai/dsh-subprocess-local'
import { expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { SenseVoiceWorker } from '../src/recognizer.ts'

const { DSH_SPEECH_E2E_ROOT: dataRoot, DSH_SPEECH_E2E_AUDIO: audioPath } = process.env

it.skipIf(!dataRoot || !audioPath)('prepares a real local recognizer, transcribes speech, and releases it', { timeout: 3_660_000, retry: 0 }, async () => {
  const ctx = new Context()
  await ctx.plugin(LocalSubprocess)
  const spawn = vi.spyOn(ctx.get('subprocess')!, 'spawn')
  const worker = new SenseVoiceWorker(ctx, Config({ dataRoot: dataRoot!,
    modelDirectory: process.env.DSH_SPEECH_E2E_MODEL,
    vadModelPath: process.env.DSH_SPEECH_E2E_VAD,
    precision: process.env.DSH_SPEECH_E2E_PRECISION === 'fp32' ? 'fp32' : 'int8',
  }))
  try {
    worker.prepare()
    await vi.waitFor(() => { expect(worker.snapshot().phase).toBe('ready') }, { timeout: 3_600_000 })
    const input = { audio: await readFile(audioPath!), language: 'zh' }
    const cold = await worker.transcribe(input, new AbortController().signal)
    const warm = await worker.transcribe(input, new AbortController().signal)
    expect(cold.text.length).toBeGreaterThan(0)
    expect(warm.text).toBe(cold.text)
    expect(warm.audioSeconds).toBeGreaterThan(0)
    await expect(worker.transcribe({ ...input, language: 'fr' }, new AbortController().signal)).rejects.toThrow('Unsupported SenseVoice language')
    expect((await worker.transcribe(input, new AbortController().signal)).text).toBe(warm.text)
    expect(spawn).toHaveBeenCalledOnce()
    console.info('SenseVoice inference', { cold, warm })
  } finally {
    await worker.dispose()
    await ctx.fiber.dispose()
    spawn.mockRestore()
  }
})
