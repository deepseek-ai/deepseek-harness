/** Model-authored operation JSON cannot supply host configuration or bypass retained identities. */
import { expect, it } from 'vitest'
import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import { CapabilitiesResult, Request, ScreenshotResult, SystemPointerRequest } from '../src/protocol.ts'

const rejectedRequests: Array<{ reason: string; request: JsonValue }> = [
  { reason: 'raw process ID instead of a selected app handle', request: { method: 'typeText', params: { pid: 17, text: 'hello' } } },
  { reason: 'unknown native method', request: { method: 'shutdown', params: {} } },
  { reason: 'zero node budget', request: { method: 'getState', params: { appHandle: 'app', maxElements: 0 } } },
  { reason: 'extra tool argument', request: { method: 'listApps', params: {}, helperPath: '/untrusted/helper' } },
  { reason: 'element click without an observed snapshot', request: { method: 'click', params: { appHandle: 'app', elementId: '0' } } },
  { reason: 'numeric element id', request: { method: 'click', params: { appHandle: 'app', snapshotId: 'snapshot', elementId: 0 } } },
  { reason: 'coordinate click without a window', request: { method: 'click', params: { appHandle: 'app', x: 1, y: 2 } } },
  { reason: 'mixed element and coordinate click', request: { method: 'click', params: { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', windowId: 23, x: 1, y: 2 } } },
  { reason: 'non-string pressKey modifier', request: { method: 'pressKey', params: { appHandle: 'app', key: 'a', modifiers: ['command', 7] } } },
  { reason: 'sendKeyEvent modifiers', request: { method: 'sendKeyEvent', params: { appHandle: 'app', key: 'a', direction: 'down', modifiers: [] } } },
  { reason: 'sendKeyEvent without direction', request: { method: 'sendKeyEvent', params: { appHandle: 'app', key: 'a' } } },
  { reason: 'sendKeyEvent invalid direction', request: { method: 'sendKeyEvent', params: { appHandle: 'app', key: 'a', direction: 'press' } } },
  { reason: 'sendKeyEvent empty key', request: { method: 'sendKeyEvent', params: { appHandle: 'app', key: '', direction: 'down' } } },
]

it.each(rejectedRequests)('rejects $reason at operation admission', ({ request }) => {
  expect(Request.safeParse(request).success).toBe(false)
})

it('admits arbitrary provider-defined pressKey modifier names', () => {
  const request = { method: 'pressKey', params: { appHandle: 'app', key: 'PlatformKey', modifiers: ['platform-modifier', 'shift'] } }
  expect(Request.parse(request)).toEqual(request)
})

it('admits arbitrary key names with an explicit key-event direction', () => {
  const request = { method: 'sendKeyEvent', params: { appHandle: 'app', windowId: 23, key: 'Command', direction: 'down' } }
  expect(Request.parse(request)).toEqual(request)
})

it.each([
  { appHandle: 'app', snapshotId: 'snapshot', elementId: '0' },
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

it('accepts disclosure options and bounded per-read traversal limits', () => {
  const params = { appHandle: 'app', includeMenus: true, details: false, maxDepth: 513, maxElements: 100001 }
  expect(Request.parse({ method: 'getState', params })).toEqual({ method: 'getState', params })
  expect(Request.safeParse({ method: 'getState', params: { ...params, details: 'all' } }).success).toBe(false)
  expect(Request.safeParse({ method: 'getState', params: { ...params, maxDepth: -1 } }).success).toBe(false)
})

it.each([
  { appHandle: 'app', snapshotId: 'snapshot', elementId: '0' },
  { appHandle: 'app', windowId: 23, x: 1, y: 2 },
])('accepts a mouse move target %j without button input', (params) => {
  expect(Request.parse({ method: 'mouseMove', params })).toEqual({ method: 'mouseMove', params })
  for (const extra of [{ mouseButton: 'left' }, { clickCount: 1 }, { modifiers: ['shift'] }, { useSystemPointer: 'yes' }]) {
    expect(Request.safeParse({ method: 'mouseMove', params: { ...params, ...extra } }).success).toBe(false)
  }
})

it.each([
  { appHandle: 'app', elementId: '0' },
  { appHandle: 'app', x: 1, y: 2 },
  { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', windowId: 23, x: 1, y: 2 },
])('rejects incomplete or mixed mouse move targets %j', (params) => {
  expect(Request.safeParse({ method: 'mouseMove', params }).success).toBe(false)
})

it('rejects the retired hover operation name', () => {
  expect(Request.safeParse({ method: 'hover', params: { appHandle: 'app', snapshotId: 'snapshot', elementId: '0' } }).success).toBe(false)
})

it.each(['0', '42.12345', 'runtime:7/child', 'e12'])('admits an opaque element id %j without provider format rules', (elementId) => {
  const params = { appHandle: 'app', snapshotId: 'snapshot', elementId }
  expect(Request.parse({ method: 'click', params })).toEqual({ method: 'click', params })
  expect(Request.safeParse({ method: 'click', params: { ...params, elementId: '' } }).success).toBe(false)
})

it('admits an element action query only with a retained snapshot identity', () => {
  const params = { appHandle: 'app', snapshotId: 'snapshot', elementId: '42.12345' }
  expect(Request.parse({ method: 'listActions', params })).toEqual({ method: 'listActions', params })
  for (const invalid of [
    { appHandle: 'app', elementId: '0' },
    { appHandle: 'app', snapshotId: 'snapshot' },
    { appHandle: 'app', snapshotId: 'snapshot', elementId: '' },
    { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', action: 'AXPress' },
  ]) expect(Request.safeParse({ method: 'listActions', params: invalid }).success).toBe(false)
})

it.each([
  { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', action: 'AXPress' },
  { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', action: 'AXPress', argument: null },
  { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', action: 'AXTextArea.AXValue.Set', argument: 'hello' },
  { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', action: 'AXTextArea.AXSelectedTextRange.Set', argument: { location: 0, length: 3 } },
  { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', action: 'AXWindow.AXPosition.Set', argument: { x: 10, y: 20 } },
])('admits performAction $action with its direct argument', (params) => {
  expect(Request.parse({ method: 'performAction', params })).toEqual({ method: 'performAction', params })
})

it('requires a retained snapshot and a nonempty action for performAction', () => {
  for (const invalid of [
    { appHandle: 'app', snapshotId: 'snapshot', elementId: '0' },
    { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', action: '' },
    { appHandle: 'app', elementId: '0', action: 'AXPress' },
    { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', action: 'AXPress', extra: true },
  ]) expect(Request.safeParse({ method: 'performAction', params: invalid }).success).toBe(false)
})

it('admits default invocation only with retained locator fields', () => {
  const params = { appHandle: 'app', snapshotId: 'snapshot', elementId: '42.12345' }
  expect(Request.parse({ method: 'invoke', params })).toEqual({ method: 'invoke', params })
  for (const invalid of [
    { appHandle: 'app', elementId: '0' },
    { appHandle: 'app', snapshotId: 'snapshot' },
    { appHandle: 'app', snapshotId: 'snapshot', elementId: '' },
    { ...params, action: 'AXPress' },
    { ...params, argument: null },
    { ...params, mouseButton: 'left' },
    { ...params, modifiers: ['shift'] },
  ]) expect(Request.safeParse({ method: 'invoke', params: invalid }).success).toBe(false)
})

it.each([
  'First document', 42, true, ['line'], { x: 10, y: 20 },
])('admits a setValue JSON value %j', (value) => {
  const params = { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', value }
  expect(Request.parse({ method: 'setValue', params })).toEqual({ method: 'setValue', params })
})

it('requires a setValue value and rejects unknown parameters', () => {
  for (const invalid of [
    { appHandle: 'app', snapshotId: 'snapshot', elementId: '0' },
    { appHandle: 'app', elementId: '0', value: 'text' },
    { appHandle: 'app', snapshotId: 'snapshot', elementId: '0', value: 'text', attribute: 'AXValue' },
  ]) expect(Request.safeParse({ method: 'setValue', params: invalid }).success).toBe(false)
})

it.each(['click', 'mouseMove', 'scroll', 'drag'])('validates 0–999 integer coordinates for %s', (method) => {
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

it.each([true, false])('requires the reported application-level accessibility capability: %s', (appLevelAccessibility) => {
  const capabilities = {
    platform: 'macos', permissions: { accessibility: true, screenRecording: false }, appLevelAccessibility,
    keyboard: ['app'], sessionLocked: false, methods: [], coordinateSpace: 'screenshot-pixels', browser: false,
  }
  expect(CapabilitiesResult.parse(capabilities)).toEqual({ ...capabilities, systemPointer: false })
  const { appLevelAccessibility: _omitted, ...missing } = capabilities
  expect(CapabilitiesResult.safeParse(missing).success).toBe(false)
})

it.each([
  { keyboard: [] },
  { keyboard: ['app'] },
  { keyboard: ['window'] },
  { keyboard: ['app', 'window'] },
  { keyboard: ['app', 'app'] },
] as const)('accepts keyboard scopes $keyboard without adding nonempty or unique constraints', ({ keyboard }) => {
  const capabilities = {
    platform: 'windows', permissions: { accessibility: true, screenRecording: true }, appLevelAccessibility: false,
    keyboard, sessionLocked: false, methods: [], coordinateSpace: 'screenshot-pixels', browser: false,
  }
  expect(CapabilitiesResult.parse(capabilities)).toEqual({ ...capabilities, systemPointer: false })
})

it.each([
  { keyboard: ['screen'] },
  { keyboard: ['app', 'screen'] },
  { keyboard: ['App'] },
])('rejects an unsupported keyboard scope in $keyboard', ({ keyboard }) => {
  const capabilities = {
    platform: 'macos', permissions: { accessibility: true, screenRecording: false }, appLevelAccessibility: true,
    keyboard, sessionLocked: false, methods: [], coordinateSpace: 'screenshot-pixels', browser: false,
  }
  expect(CapabilitiesResult.safeParse(capabilities).success).toBe(false)
})

it('requires keyboard scopes', () => {
  const capabilities = {
    platform: 'macos', permissions: { accessibility: true, screenRecording: false }, appLevelAccessibility: true,
    sessionLocked: false, methods: [], coordinateSpace: 'screenshot-pixels', browser: false,
  }
  expect(CapabilitiesResult.safeParse(capabilities).success).toBe(false)
})

it('admits the pointer option only in the system-pointer model schema and only as a boolean', () => {
  const target = { appHandle: 'app', windowId: 1, x: 0, y: 0 }
  const request = { method: 'mouseMove', params: { ...target, useSystemPointer: true } }
  expect(Request.safeParse(request).success).toBe(false)
  expect(SystemPointerRequest.safeParse(request).success).toBe(true)
  expect(SystemPointerRequest.safeParse({ ...request, params: { ...target, useSystemPointer: 'true' } }).success).toBe(false)
  expect(SystemPointerRequest.safeParse({ ...request, params: { ...target, arbitraryField: true } }).success).toBe(false)
})
