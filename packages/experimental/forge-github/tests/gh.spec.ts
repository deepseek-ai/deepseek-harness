import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GhOutputLimitError, GhTimeoutError, GhUnavailableError, ghRunner } from '../src/gh.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-forge-gh-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

/** A POSIX stand-in for gh whose first argument selects its behavior. */
async function fakeGh(): Promise<string> {
  const path = join(root, 'gh')
  await writeFile(path, [
    '#!/bin/sh',
    'case "$1" in',
    '  echo) printf "%s|" "$@"; printf "\\nprompt=%s token=%s pager=[%s]\\n" "$GH_PROMPT_DISABLED" "${GH_TOKEN:-unset}" "$GH_PAGER" ;;',
    '  input) cat ;;',
    '  fail) echo oops >&2; exit 3 ;;',
    '  sleep) sleep 5 ;;',
    '  big) head -c 5000 /dev/zero | tr "\\0" x ;;',
    'esac',
    '',
  ].join('\n'))
  await chmod(path, 0o755)
  return path
}

describe.skipIf(process.platform === 'win32')('gh runner', () => {
  it('delivers review JSON through stdin without interpreting shell syntax', async () => {
    const run = ghRunner({ ghCommand: await fakeGh(), timeoutMs: 5_000, maxOutputBytes: 10_000 })
    const body = JSON.stringify({ body: 'Check `$(secret)`\n检查边界' })
    await expect(run(['input'], new AbortController().signal, body)).resolves.toEqual({ exitCode: 0, stdout: body, stderr: '' })
  })

  it('runs gh with literal arguments and a scrubbed, non-interactive environment', async () => {
    vi.stubEnv('GH_TOKEN', 'secret-token')
    const run = ghRunner({ ghCommand: await fakeGh(), timeoutMs: 5_000, maxOutputBytes: 10_000 })

    await expect(run(['echo', 'a b', '--flag'], new AbortController().signal)).resolves.toEqual({
      exitCode: 0,
      stdout: 'echo|a b|--flag|\nprompt=1 token=unset pager=[]',
      stderr: '',
    })
  })

  it('returns a nonzero exit code with its stderr', async () => {
    const run = ghRunner({ ghCommand: await fakeGh(), timeoutMs: 5_000, maxOutputBytes: 10_000 })

    await expect(run(['fail'], new AbortController().signal)).resolves.toEqual({ exitCode: 3, stdout: '', stderr: 'oops' })
  })

  it('rejects when gh outlives the timeout', async () => {
    const run = ghRunner({ ghCommand: await fakeGh(), timeoutMs: 100, maxOutputBytes: 10_000 })

    const result = run(['sleep'], new AbortController().signal)

    await expect(result).rejects.toBeInstanceOf(GhTimeoutError)
    await expect(result).rejects.toThrow('gh sleep timed out after 100ms')
  })

  it('rejects with the abort reason when cancelled', async () => {
    const run = ghRunner({ ghCommand: await fakeGh(), timeoutMs: 5_000, maxOutputBytes: 10_000 })
    const controller = new AbortController()
    setTimeout(() => {
      controller.abort(new Error('stop requested'))
    }, 50)

    await expect(run(['sleep'], controller.signal)).rejects.toThrow('stop requested')
  })

  it('rejects output beyond maxOutputBytes', async () => {
    const run = ghRunner({ ghCommand: await fakeGh(), timeoutMs: 5_000, maxOutputBytes: 1_000 })

    const result = run(['big'], new AbortController().signal)

    await expect(result).rejects.toBeInstanceOf(GhOutputLimitError)
    await expect(result).rejects.toThrow('gh big output exceeds maxOutputBytes')
  })

  it('reports an executable that cannot start', async () => {
    const run = ghRunner({ ghCommand: join(root, 'missing-gh'), timeoutMs: 5_000, maxOutputBytes: 1_000 })
    const result = run([], new AbortController().signal)

    await expect(result).rejects.toBeInstanceOf(GhUnavailableError)
    await expect(result).rejects.toThrow(/^gh could not start: /)
  })
})
