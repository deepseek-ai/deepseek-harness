// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createTrajectoryStringWrappingStore } from '../src/client/string-wrapping-store.ts'

const key = 'dsh.trajectory.jsonStringWrapping'
let original: string | null

beforeEach(() => {
  original = localStorage.getItem(key)
  localStorage.removeItem(key)
})

afterEach(() => {
  if (original === null) localStorage.removeItem(key)
  else localStorage.setItem(key, original)
})

it('restores the last wrapping choice when the view is recreated', () => {
  const first = createTrajectoryStringWrappingStore()
  expect(first.getSnapshot()).toBe(false)
  first.set(true)
  const second = createTrajectoryStringWrappingStore()
  expect(second.getSnapshot()).toBe(true)
  second.set(false)
  expect(createTrajectoryStringWrappingStore().getSnapshot()).toBe(false)
})
