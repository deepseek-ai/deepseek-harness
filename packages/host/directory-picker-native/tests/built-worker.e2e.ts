/**
 * Keyless built-artifact guard: plain `node` runs `lib/worker.cjs` and the bundle reaches its
 * real koffi requires. POSIX hosts prove the load path end to end through
 * the deterministic ole32 rejection; win32 skips (a real dialog would
 * open), where the win32-only smoke in win32-dialog.spec.ts covers the
 * source plane instead. Skips until a build produces the artifact.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Win32DialogWorkerMessage } from '../src/win32-dialog-worker.ts'

const builtWorker = fileURLToPath(new URL('../lib/worker.cjs', import.meta.url))

describe.skipIf(!existsSync(builtWorker) || process.platform === 'win32')('built dialog worker (lib/worker.cjs)', () => {
  it('loads under plain node and reports the native-surface failure', async () => {
    const message = await new Promise<Win32DialogWorkerMessage>((resolve, reject) => {
      const child = spawn(process.execPath, [builtWorker], {
        env: { ...process.env, DSH_DIALOG_TITLE: 'Built-artifact guard' },
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      })
      child.on('message', resolve)
      child.on('error', reject)
      child.on('exit', (code) => {
        reject(new Error(`worker exited (${code}) before reporting`))
      })
    })
    expect(message.kind).toBe('error')
    expect((message as { kind: 'error'; message: string }).message).toMatch(/ole32|koffi/i)
  }, 30_000)
})
