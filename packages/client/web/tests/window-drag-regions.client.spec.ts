// @vitest-environment node
/**
 * The composition rule every coverage claim is decided by: Electron applies
 * app-region boxes by geometry in DOM order, so the last box containing a
 * point decides it. The cases below pin the direction of that order (a later
 * `no-drag` wins over an earlier `drag`, a later `drag` re-adds what an
 * earlier `no-drag` removed) and the edge semantics callers rely on.
 */
import { describe, expect, it } from 'vitest'
import {
  INTERACTIVE_SELECTOR, containsPoint, isDraggableAt, type RegionRect,
} from '../src/window-drag/regions.ts'

const box = (x: number, y: number, width: number, height: number, draggable: boolean): RegionRect =>
  ({ x, y, width, height, draggable })

describe('window drag-region composition', () => {
  it('keeps a point outside every box undraggable', () => {
    expect(isDraggableAt([box(0, 0, 100, 52, true)], 50, 80)).toBe(false)
    expect(isDraggableAt([], 50, 20)).toBe(false)
  })

  it('drags inside a lone band and stops at its edges', () => {
    const band = [box(0, 0, 100, 52, true)]
    expect(isDraggableAt(band, 0, 0)).toBe(true)
    expect(isDraggableAt(band, 99, 51)).toBe(true)
    expect(isDraggableAt(band, 100, 51)).toBe(false)
    expect(isDraggableAt(band, 99, 52)).toBe(false)
  })

  it('lets a later no-drag box subtract an earlier drag box', () => {
    const regions = [box(0, 0, 100, 52, true), box(20, 10, 28, 28, false)]
    expect(isDraggableAt(regions, 34, 24)).toBe(false)
    expect(isDraggableAt(regions, 4, 24)).toBe(true)
  })

  it('lets a later drag box re-add what an earlier no-drag box removed', () => {
    const regions = [box(0, 0, 100, 52, true), box(20, 10, 28, 28, false), box(20, 10, 28, 28, true)]
    expect(isDraggableAt(regions, 34, 24)).toBe(true)
  })

  it('decides by document order, not by box size or direction', () => {
    const wide = box(0, 0, 100, 52, true)
    const small = box(20, 10, 28, 28, false)
    expect(isDraggableAt([wide, small], 34, 24)).toBe(false)
    expect(isDraggableAt([small, wide], 34, 24)).toBe(true)
  })

  it('treats edges as half-open so adjacent boxes never both claim a point', () => {
    expect(containsPoint(box(0, 0, 10, 10, true), 10, 5)).toBe(false)
    expect(containsPoint(box(0, 0, 10, 10, true), 9.999, 9.999)).toBe(true)
  })

  it('publishes the interactive selector base.css declares', () => {
    for (const part of ['button', 'a', "[role='tab']", '[tabindex]', "[contenteditable='true']"]) {
      expect(INTERACTIVE_SELECTOR.split(', ')).toContain(part)
    }
    expect(INTERACTIVE_SELECTOR).not.toContain(':is(')
  })
})
