/** Pixel mappings follow the delivered screenshot and invalidate independently of AX indices. */
import { expect, it } from 'vitest'
import { CuaCoordinates } from '../src/coordinates.ts'
import { Request } from '../src/protocol.ts'
import type { CuaAppHandle, CuaWindowInfo } from '../src/types.ts'

const handle = 'app' as CuaAppHandle
const window = (width = 640, height = 480, x = 100): CuaWindowInfo => ({
  windowId: 7, pid: 17, appName: 'Fixture', title: 'Window', bounds: { x, y: 200, width, height }, isOnScreen: true, onCurrentSpace: true,
})
const call = (method: string, params: object) => Request.parse({ method, params: { appHandle: handle, windowId: 7, ...params } })

it('maps Retina and downscaled screenshot pixels to the same native point', () => {
  const coordinates = new CuaCoordinates()
  for (const pixels of [{ width: 1280, height: 960 }, { width: 320, height: 240 }]) {
    coordinates.screenshot(handle, 7, window().bounds, pixels)
    for (const method of ['click', 'hover', 'scroll']) {
      const request = call(method, { x: pixels.width / 2, y: pixels.height / 4,
        ...method === 'scroll' ? { deltaLinesX: 0, deltaLinesY: -1 } : {} })
      expect(coordinates.parameters(request)).toMatchObject({ x: 320, y: 120 })
    }
  }
})

it.each(['click', 'hover', 'scroll'])('preserves thousandth scaling for %s across screenshot resolutions', (method) => {
  const coordinates = new CuaCoordinates()
  const bounds = window(1200, 900).bounds
  coordinates.observe(handle, [window(1200, 900)])
  const params = { relative: true, ...method === 'scroll' ? { deltaLinesX: 0, deltaLinesY: -1 } : {} }
  const assertPoints = () => {
    expect(coordinates.parameters(call(method, { ...params, x: 500, y: 250 }))).toMatchObject({ x: 600, y: 225 })
    expect(coordinates.parameters(call(method, { ...params, x: 999, y: 999 }))).toMatchObject({ x: 1198.8, y: 899 })
    expect(coordinates.parameters(call(method, { ...params, x: 0, y: 0 }))).toMatchObject({ x: 0, y: 0 })
  }
  assertPoints()
  for (const image of [{ width: 2400, height: 1800 }, { width: 300, height: 225 }]) {
    coordinates.screenshot(handle, 7, bounds, image)
    assertPoints()
  }
})

it('maps relative drag endpoints and keeps 999 inside a one-point window', () => {
  const coordinates = new CuaCoordinates()
  coordinates.observe(handle, [window(1200, 900)])
  const params = { fromX: 0, fromY: 250, toX: 999, toY: 500, relative: true }
  expect(coordinates.parameters(call('drag', params))).toEqual({ appHandle: handle, windowId: 7,
    fromX: 0, fromY: 225, toX: 1198.8, toY: 450 })
  coordinates.observe(handle, [window(1, 1)])
  expect(coordinates.parameters(call('click', { x: 999, y: 999, relative: true }))).toMatchObject({ x: 0, y: 0 })
})

it('maps both drag endpoints and preserves button, modifiers and snapshot identity', () => {
  const coordinates = new CuaCoordinates()
  coordinates.screenshot(handle, 7, window().bounds, { width: 1280, height: 960 })
  const options = { fromX: 320, fromY: 240, toX: 640, toY: 480, relative: false, snapshotId: 'snapshot', mouseButton: 'right', modifiers: ['shift'] }
  expect(coordinates.parameters(call('drag', options))).toEqual({ appHandle: handle, windowId: 7,
    fromX: 160, fromY: 120, toX: 320, toY: 240, snapshotId: 'snapshot', mouseButton: 'right', modifiers: ['shift'] })
})

it('preserves pixels after movement but requires a new image after resize or close', () => {
  const coordinates = new CuaCoordinates()
  coordinates.screenshot(handle, 7, window().bounds, { width: 1280, height: 960 })
  const request = call('click', { x: 640, y: 480 })
  coordinates.observe(handle, [window(640, 480, -900)])
  expect(coordinates.parameters(request)).toMatchObject({ x: 320, y: 240 })
  coordinates.observe(handle, [window(800, 600)])
  expect(() => coordinates.parameters(request)).toThrow('SCREENSHOT_REQUIRED')
  expect(coordinates.parameters(call('click', { x: 999, y: 999, relative: true }))).toMatchObject({ x: 799, y: 599 })
  coordinates.observe(handle, [])
  expect(() => coordinates.parameters(request)).toThrow('STALE_SNAPSHOT')
})

it('rejects unobserved, empty and out-of-image targets without native dispatch', () => {
  const coordinates = new CuaCoordinates()
  expect(() => coordinates.parameters(call('hover', { x: 1, y: 1 }))).toThrow('STALE_SNAPSHOT')
  coordinates.observe(handle, [window(0, 480)])
  expect(() => coordinates.parameters(call('hover', { x: 0, y: 0, relative: true }))).toThrow('STALE_SNAPSHOT')
  coordinates.observe(handle, [window(640, 0)])
  expect(() => coordinates.parameters(call('hover', { x: 0, y: 0, relative: true }))).toThrow('STALE_SNAPSHOT')
  coordinates.screenshot(handle, 7, window().bounds, { width: 320, height: 240 })
  for (const [x, y] of [[320, 0], [0, 240]]) expect(() => coordinates.parameters(call('click', { x, y }))).toThrow('INVALID_ARGUMENT')
})

it('keeps different application/window mappings independent and leaves element actions unchanged', () => {
  const coordinates = new CuaCoordinates()
  coordinates.observe(handle, [window()])
  coordinates.screenshot(handle, 7, window().bounds, { width: 1280, height: 960 })
  coordinates.screenshot('other' as CuaAppHandle, 7, window(100, 100).bounds, { width: 100, height: 100 })
  expect(coordinates.parameters(call('click', { x: 640, y: 480 }))).toMatchObject({ x: 320, y: 240 })
  const request = Request.parse({ method: 'hover', params: { appHandle: handle, snapshotId: 's', elementIndex: 2 } })
  expect(coordinates.parameters(request)).toEqual(request.params)
})

it('keeps other windows mapped during scoped observations and only removes the scoped closed window', () => {
  const coordinates = new CuaCoordinates()
  coordinates.screenshot(handle, 7, window().bounds, { width: 1280, height: 960 })
  coordinates.observe(handle, [{ ...window(), windowId: 8 }], 8)
  expect(coordinates.parameters(call('click', { x: 640, y: 480 }))).toMatchObject({ x: 320, y: 240 })
  coordinates.observe(handle, [], 8)
  expect(coordinates.parameters(call('click', { x: 640, y: 480 }))).toMatchObject({ x: 320, y: 240 })
  coordinates.observe(handle, [], 7)
  expect(() => coordinates.parameters(call('click', { x: 0, y: 0 }))).toThrow('STALE_SNAPSHOT')
})
