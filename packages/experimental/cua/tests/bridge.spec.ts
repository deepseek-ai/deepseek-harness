/** Retained app objects use fresh execution bindings while tool results own image admission. */
import { Buffer } from 'node:buffer'
import { expect, it, vi } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { connectCua } from '../src/bridge.ts'
import type { CuaToolBinding } from '../src/bridge.ts'
import type { CuaOperation } from '../src/types.ts'

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWNgZGIGAAAOAAeCcsnOAAAAAElFTkSuQmCC'
const selected = { appHandle: 'app-17', pid: 17, name: 'Editor' }
const bounds = { x: 0, y: 0, width: 640, height: 480 }
const snapshot = {
  appHandle: 'app-17', pid: 17, windowId: null, snapshotId: 'snapshot-1', tree: '0 button', truncated: false,
  windows: [{ windowId: 23, pid: 17, appName: 'Editor', title: 'Document', bounds, isOnScreen: true, onCurrentSpace: null }],
}

it('uses the current tool binding when a retained app is called by another execution', async () => {
  const first = vi.fn(async (operation: CuaOperation): Promise<JsonValue> => operation.method === 'getApp' ? selected : snapshot)
  let current: CuaToolBinding = first
  const text = vi.fn()
  const cua = connectCua(() => current, text)
  const app = await cua.getApp('Editor')
  const second = vi.fn(async (): Promise<JsonValue> => ({ dispatched: true, verified: false }))
  current = second

  await expect(app.click(0)).resolves.toEqual({ dispatched: true, verified: false })
  expect(first).toHaveBeenCalledTimes(2)
  expect(second).toHaveBeenCalledWith({ method: 'click', params: { appHandle: 'app-17', snapshotId: 'snapshot-1', elementIndex: 0 } })
  expect(text).toHaveBeenCalledWith('0 button')
})

it('propagates a denied action without retrying it', async () => {
  const denial = new Error('Action denied by the user')
  const tool = vi.fn(async (): Promise<JsonValue> => { throw denial })
  const cua = connectCua(() => tool)
  await expect(cua.getApp('Editor')).rejects.toBe(denial)
  expect(tool).toHaveBeenCalledTimes(1)
})

it('supports callers that retain observations without a text callback', async () => {
  const cua = connectCua(() => async () => [{ pid: 17, name: 'Editor' }])
  await expect(cua.listApps()).resolves.toEqual([{ id: '17', displayName: 'Editor', isRunning: true, pid: 17 }])
})

it.each([null, 'text only', { content: [{ type: 'text', text: '{}' }] }])('rejects an unusable tool result %j', async (result) => {
  const cua = connectCua(() => async () => result)
  await expect(cua.getState()).rejects.toThrow()
})

it('returns screenshot bytes and metadata with one image-bearing tool call and no image text output', async () => {
  const tool = vi.fn(async (operation: CuaOperation): Promise<JsonValue> => {
    if (operation.method === 'getApp') return selected
    if (operation.method === 'getState') return snapshot
    return {
      mimeType: 'image/png', data: PNG, pixelWidth: 1, pixelHeight: 1, windowId: 23, bounds, coordinateSpace: 'screenshot-pixels',
    }
  })
  const text = vi.fn()
  const app = await connectCua(() => tool, text).getApp('Editor')
  text.mockClear()

  expect(await app.getScreenshot()).toEqual({ bytes: Uint8Array.from(Buffer.from(PNG, 'base64')), mimeType: 'image/png', pixelWidth: 1, pixelHeight: 1, windowId: 23 })
  expect(tool.mock.calls.map(([operation]) => operation.method)).toEqual(['getApp', 'getState', 'screenshot'])
  expect(text).not.toHaveBeenCalled()
})
