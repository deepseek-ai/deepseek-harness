import { chmod, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GlabOutputLimitError, GlabTimeoutError, GlabUnavailableError, glabRunner } from '../src/glab.ts'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-forge-glab-'))
})

afterEach(async () => {
  vi.unstubAllEnvs()
  await rm(root, { recursive: true, force: true })
})

/** A POSIX stand-in for glab whose first argument selects its behavior. */
async function fakeGlab(): Promise<string> {
  const path = join(root, 'glab')
  await writeFile(path, [
    '#!/bin/sh',
    'case "$1" in',
    '  echo) printf "%s|" "$@"; printf "\\nprompt=%s update=%s telemetry=%s host=%s repo=%s token=%s cwd=%s\\n" "$GLAB_NO_PROMPT" "$GLAB_CHECK_UPDATE" "$GLAB_SEND_TELEMETRY" "${GITLAB_HOST:-unset}" "${GITLAB_REPO:-unset}" "${GITLAB_TOKEN:-unset}" "$(pwd -P)" ;;',
    '  input) cat ;;',
    '  file) printf "line\\n\\n" ;;',
    '  fail) echo oops >&2; exit 3 ;;',
    // exec, so the deadline kill reaches the process holding the pipes.
    '  sleep) exec sleep 5 ;;',
    '  big) head -c 5000 /dev/zero | tr "\\0" x ;;',
    'esac',
    '',
  ].join('\n'))
  await chmod(path, 0o755)
  return path
}

describe.skipIf(process.platform === 'win32')('glab runner', () => {
  it('delivers request JSON through stdin without interpreting shell syntax', async () => {
    const run = glabRunner({ glabCommand: await fakeGlab(), timeoutMs: 5_000, maxOutputBytes: 10_000 })
    const body = JSON.stringify({ query: 'query { currentUser { username } }', note: '`$(secret)` 检查' })
    await expect(run(['input'], new AbortController().signal, body)).resolves.toEqual({ exitCode: 0, stdout: body, stderr: '' })
  })

  it('keeps the final newlines of a raw file read', async () => {
    const run = glabRunner({ glabCommand: await fakeGlab(), timeoutMs: 5_000, maxOutputBytes: 10_000 })

    await expect(run(['file'], new AbortController().signal)).resolves.toEqual({ exitCode: 0, stdout: 'line\n\n', stderr: '' })
  })

  it('runs glab in the temporary directory without variables that redirect it to another host or repository', async () => {
    vi.stubEnv('GITLAB_HOST', 'elsewhere.test')
    vi.stubEnv('GITLAB_REPO', 'other/repo')
    vi.stubEnv('GITLAB_TOKEN', 'secret-token')
    const run = glabRunner({ glabCommand: await fakeGlab(), timeoutMs: 5_000, maxOutputBytes: 10_000 })

    await expect(run(['echo', 'a b', '--flag'], new AbortController().signal)).resolves.toEqual({
      exitCode: 0,
      stdout: `echo|a b|--flag|\nprompt=1 update=false telemetry=false host=unset repo=unset token=unset cwd=${await realpath(tmpdir())}\n`,
      stderr: '',
    })
  })

  it('returns a nonzero exit code with its stderr', async () => {
    const run = glabRunner({ glabCommand: await fakeGlab(), timeoutMs: 5_000, maxOutputBytes: 10_000 })

    await expect(run(['fail'], new AbortController().signal)).resolves.toEqual({ exitCode: 3, stdout: '', stderr: 'oops\n' })
  })

  it('rejects when glab outlives the timeout', async () => {
    const run = glabRunner({ glabCommand: await fakeGlab(), timeoutMs: 100, maxOutputBytes: 10_000 })

    const result = run(['sleep'], new AbortController().signal)

    await expect(result).rejects.toBeInstanceOf(GlabTimeoutError)
    await expect(result).rejects.toThrow('glab sleep timed out after 100ms')
  })

  it('rejects with the abort reason when cancelled', async () => {
    const run = glabRunner({ glabCommand: await fakeGlab(), timeoutMs: 5_000, maxOutputBytes: 10_000 })
    const controller = new AbortController()
    setTimeout(() => { controller.abort(new Error('stop requested')) }, 50)

    await expect(run(['sleep'], controller.signal)).rejects.toThrow('stop requested')
  })

  it('rejects output beyond maxOutputBytes', async () => {
    const run = glabRunner({ glabCommand: await fakeGlab(), timeoutMs: 5_000, maxOutputBytes: 1_000 })

    const result = run(['big'], new AbortController().signal)

    await expect(result).rejects.toBeInstanceOf(GlabOutputLimitError)
    await expect(result).rejects.toThrow('glab big output exceeds maxOutputBytes')
  })

  it('reports an executable that cannot start', async () => {
    const run = glabRunner({ glabCommand: join(root, 'missing-glab'), timeoutMs: 5_000, maxOutputBytes: 1_000 })
    const result = run([], new AbortController().signal)

    await expect(result).rejects.toBeInstanceOf(GlabUnavailableError)
    await expect(result).rejects.toThrow(/^glab could not start: /)
  })
})
