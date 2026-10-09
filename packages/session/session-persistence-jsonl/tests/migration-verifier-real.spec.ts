import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { verifyCurrentGenerationInWorker } from '../src/migration-verifier.ts'
import { compressZstdFrame } from '../src/zstd.ts'

describe('real migration verifier shutdown', () => {
  it.for(['none', 'zstd'] as const)('naturally exits after verifying %s input', async (compression, { signal }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-verifier-natural-'))
    onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
    const path = join(root, 'staged.jsonl')
    const header = Buffer.from(JSON.stringify({
      type: 'session', version: SESSION_FORMAT_VERSION, id: 'natural-exit',
      createdAt: 1, delegationDepth: 0, isSeeded: false,
    }) + '\n')
    const bytes = compression === 'none' ? header : await compressZstdFrame(header)
    const terminate = vi.spyOn(Worker.prototype, 'terminate')
    try {
      await writeFile(path, bytes)
      const result = await verifyCurrentGenerationInWorker(path, compression, 'natural-exit', 0, undefined, signal)
      expect(result).toMatchObject({
        bytes: bytes.length,
        digest: createHash('sha256').update(bytes).digest('hex'),
      })
      expect(terminate).not.toHaveBeenCalled()
      expect(await readFile(path)).toEqual(bytes)
      await rm(root, { recursive: true, force: true })
    } finally {
      terminate.mockRestore()
      await rm(root, { recursive: true, force: true })
    }
  })
})
