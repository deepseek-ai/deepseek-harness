/** Both native languages admit the same generated model and Host operation fields. */
import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { nativeProtocol } from '@deepseek-ai/dsh-cua/native-schema'
import { ActionResult, NativeScreenshotResult } from '@deepseek-ai/dsh-cua/protocol'
import { Config } from '../src/index.ts'

it('keeps the C# admission schema identical to the shared generated schema', async () => {
  expect(await readFile(new URL('../native/protocol.schema.json', import.meta.url), 'utf8')).toBe(nativeProtocol().json)
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
