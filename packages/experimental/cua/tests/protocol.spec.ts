/** Model-authored operation JSON cannot supply host configuration or bypass retained identities. */
import { expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { Request, ScreenshotResult } from '../src/protocol.ts'

const rejectedRequests: Array<{ reason: string; request: JsonValue }> = [
  { reason: 'raw process ID instead of a selected app handle', request: { method: 'typeText', params: { pid: 17, text: 'hello' } } },
  { reason: 'unknown native method', request: { method: 'shutdown', params: {} } },
  { reason: 'host-owned traversal limit', request: { method: 'getState', params: { appHandle: 'app', maxElements: 1000000 } } },
  { reason: 'extra tool argument', request: { method: 'listApps', params: {}, helperPath: '/untrusted/helper' } },
  { reason: 'element click without an observed snapshot', request: { method: 'click', params: { appHandle: 'app', elementIndex: 0 } } },
  { reason: 'coordinate click without a window', request: { method: 'click', params: { appHandle: 'app', x: 1, y: 2 } } },
  { reason: 'mixed element and coordinate click', request: { method: 'click', params: { appHandle: 'app', snapshotId: 'snapshot', elementIndex: 0, windowId: 23, x: 1, y: 2 } } },
  { reason: 'unsupported modifier', request: { method: 'pressKey', params: { appHandle: 'app', key: 'a', modifiers: ['hyper'] } } },
]

it.each(rejectedRequests)('rejects $reason at operation admission', ({ request }) => {
  expect(Request.safeParse(request).success).toBe(false)
})

it.each([
  { appHandle: 'app', snapshotId: 'snapshot', elementIndex: 0 },
  { appHandle: 'app', windowId: 23, x: 1, y: 2 },
  { appHandle: 'app', windowId: 23, x: 1, y: 2, relative: true },
])('validates optional per-press hold duration for %j', (params) => {
  for (const holdMs of [0, 1, 800, 5000, 7000]) {
    const request = { method: 'click', params: { ...params, holdMs } }
    expect(Request.parse(request)).toEqual(request)
  }
  for (const holdMs of [-1, 1.5, Infinity, NaN, '800', null]) {
    expect(Request.safeParse({ method: 'click', params: { ...params, holdMs } }).success).toBe(false)
  }
})

it.each([
  '', 'not base64!', 'AQ', 'AQ===', 'AQ==\n', 'A Q==', 'AQ-_', 'AB==', 'AAF=',
])('rejects noncanonical screenshot base64 %j', (data) => {
  expect(ScreenshotResult.safeParse({
    mimeType: 'image/png', data, pixelWidth: 1, pixelHeight: 1, windowId: 23,
    bounds: { x: 0, y: 0, width: 10, height: 10 }, coordinateSpace: 'screenshot-pixels',
  }).success).toBe(false)
})

it.each([
  { mimeType: 'application/octet-stream' }, { pixelWidth: 0 }, { pixelHeight: -1 }, { windowId: 0 },
  { bounds: { x: 0, y: 0, width: 0, height: 10 } }, { coordinateSpace: 'screen-pixels' },
])('retains screenshot metadata validation for %j', (invalid) => {
  expect(ScreenshotResult.safeParse({
    mimeType: 'image/png', data: 'AQ==', pixelWidth: 1, pixelHeight: 1, windowId: 23,
    bounds: { x: 0, y: 0, width: 10, height: 10 }, coordinateSpace: 'screenshot-pixels', ...invalid,
  }).success).toBe(false)
})

it('accepts disclosure options without accepting host traversal limits', () => {
  const params = { appHandle: 'app', includeMenus: true, details: false }
  expect(Request.parse({ method: 'getState', params })).toEqual({ method: 'getState', params })
  expect(Request.safeParse({ method: 'getState', params: { ...params, details: 'all' } }).success).toBe(false)
  expect(Request.safeParse({ method: 'getState', params: { ...params, maxDepth: 100 } }).success).toBe(false)
})

it.each([
  { appHandle: 'app', snapshotId: 'snapshot', elementIndex: 0 },
  { appHandle: 'app', windowId: 23, x: 1, y: 2 },
])('accepts a hover target %j without button input', (params) => {
  expect(Request.parse({ method: 'hover', params })).toEqual({ method: 'hover', params })
  for (const extra of [{ mouseButton: 'left' }, { clickCount: 1 }, { modifiers: ['shift'] }, { useSystemPointer: 'yes' }]) {
    expect(Request.safeParse({ method: 'hover', params: { ...params, ...extra } }).success).toBe(false)
  }
})

it.each([
  { appHandle: 'app', elementIndex: 0 },
  { appHandle: 'app', x: 1, y: 2 },
  { appHandle: 'app', snapshotId: 'snapshot', elementIndex: 0, windowId: 23, x: 1, y: 2 },
])('rejects incomplete or mixed hover targets %j', (params) => {
  expect(Request.safeParse({ method: 'hover', params }).success).toBe(false)
})

it.each(['click', 'hover', 'scroll', 'drag'])('validates 0–999 integer coordinates for %s', (method) => {
  const params = { appHandle: 'app', windowId: 7, relative: true,
    ...method === 'drag' ? { fromX: 0, fromY: 0, toX: 999, toY: 999 } : { x: 0, y: 999 },
    ...method === 'scroll' ? { deltaLinesX: 0, deltaLinesY: -1 } : {},
  }
  expect(Request.safeParse({ method, params }).success).toBe(true)
  for (const field of method === 'drag' ? ['fromX', 'fromY', 'toX', 'toY'] : ['x', 'y']) {
    for (const value of [-1, 1000, 0.5]) {
      expect(Request.safeParse({ method, params: { ...params, [field]: value } }).success).toBe(false)
    }
    expect(Request.safeParse({ method, params: { ...params, relative: false, [field]: 1000 } }).success).toBe(true)
  }
})
