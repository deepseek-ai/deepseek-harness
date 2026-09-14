/** Failed executable startup emits close without exit and must not hang cleanup. */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { launchChromium } from '../src/launch.ts'
import { nativeModel } from './fixtures/stagehand.ts'

it('releases a real failed spawn without waiting for an exit event', async () => {
  await expect(launchChromium({
    model: nativeModel, mode: 'launch', executablePath: join(tmpdir(), `missing-browser-${randomUUID()}`),
    headless: true, operationTimeoutMs: 5000, shutdownGraceMs: 50,
  }, new AbortController().signal)).rejects.toThrow('Failed to launch the browser process')
})
