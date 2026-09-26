import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it.each(['utf-8', 'cp1252'])('executes the shipped OOXML checker against valid, edited, and broken documents with %s stdout', (encoding) => {
  const python = process.env.DSH_OFFICE_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  const result = spawnSync(python, [fileURLToPath(new URL('./check_office_test.py', import.meta.url))], {
    env: { ...process.env, PYTHONIOENCODING: encoding },
    encoding: 'utf8', timeout: 30_000,
  })
  expect(result.error).toBeUndefined()
  expect(result.signal, result.stderr + result.stdout).toBeNull()
  expect(result.status, result.stderr + result.stdout).toBe(0)
})
