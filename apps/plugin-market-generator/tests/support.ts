/** Per-test temporary directories and cleanups shared by the generator specs. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, vi } from 'vitest'

const cleanups: (() => void | Promise<void>)[] = []

/** Every cleanup runs after each test, in reverse order, even when an earlier one fails. */
afterEach(async () => {
  const errors: unknown[] = []
  for (const cleanup of cleanups.splice(0).reverse()) {
    try {
      await cleanup()
    } catch (error) {
      errors.push(error)
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, 'test cleanup failed')
})

/**
 * Register a cleanup for the current test.
 * @param cleanup - runs after the test.
 */
export function onCleanup(cleanup: () => void | Promise<void>): void {
  cleanups.push(cleanup)
}

/** @returns a new temporary directory deleted after the current test. */
export function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'market-generator-'))
  onCleanup(() => { rmSync(dir, { recursive: true, force: true }) })
  return dir
}

/**
 * Set a process environment variable until the current test ends.
 * @param name - variable name.
 * @param value - value for the test.
 */
export function setEnv(name: string, value: string): void {
  vi.stubEnv(name, value)
  onCleanup(() => { vi.unstubAllEnvs() })
}
