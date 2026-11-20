/** Both native languages admit the same generated model and Host operation fields. */
import { expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { ActionResult, NativeScreenshotResult } from '@deepseek-ai/dsh-cua/protocol'
import { Config } from '../src/index.ts'

it('keeps the C# admission schema current with the Windows generator', () => {
  const result = spawnSync(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../native/generate-protocol.ts', import.meta.url)), '--check'],
    { encoding: 'utf8' })
  expect(result.status, result.stderr).toBe(0)
})

it('preserves Windows physical capture units and observed foreground changes', () => {
  const image = { mimeType: 'image/png', data: 'AAAA', pixelWidth: 1200, pixelHeight: 800, windowId: '1',
    bounds: { x: -1200, y: 0, width: 1200, height: 800 }, coordinateSpace: 'window-pixels' }
  expect(NativeScreenshotResult.parse(image).coordinateSpace).toBe('window-pixels')
  expect(() => NativeScreenshotResult.parse({ ...image, coordinateSpace: 'screen-pixels' })).toThrow()
  expect(ActionResult.parse({ dispatched: true, verified: false, foregroundChanged: true })).toEqual({
    dispatched: true, foregroundChanged: true,
  })
})

it('resolves Windows input defaults without a compiler path setting', () => {
  const resolved = Config({})
  expect(resolved).not.toHaveProperty('dotnetPath')
  expect(resolved.pollIntervalMs).toBe(25)
  expect(resolved.textEventIntervalMs).toBe(0)
  expect(() => Config({ pollIntervalMs: 0 })).toThrow()
  expect(() => Config({ maxResponseBytes: 2 ** 31 })).toThrow()
})
