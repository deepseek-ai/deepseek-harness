import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { resolveExampleLaunch } from '@deepseek-ai/dsh-loader-smoke'

interface Observation {
  kind: 'probe' | 'session'
  runtime: string
  args: string[]
  environment: Record<string, string | null>
}

it('scrubs real native probes and leaves inherited Claude session markers removed', { timeout: 60_000, retry: 0 }, async (test) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-oar-environment-'))
  test.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const nativeScript = fileURLToPath(new URL('./fixtures/environment-probe.mjs', import.meta.url))
  const executable = join(root, process.platform === 'win32' ? 'native-fixture.cmd' : 'native-fixture')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  await writeFile(executable, process.platform === 'win32'
    ? `@echo off\r\n"${process.execPath}" "${nativeScript}" %*\r\n`
    : `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(nativeScript)} "$@"\n`)
  if (process.platform !== 'win32') await chmod(executable, 0o700)
  const capture = join(root, 'observations.jsonl')
  const launch = resolveExampleLaunch({
    srcBin: fileURLToPath(new URL('./fixtures/environment-driver.ts', import.meta.url)),
    mode: 'src',
    sourceImport: 'tsx/esm',
    tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
    env: {
      OAR_CODEX_BIN: executable,
      OAR_CLAUDE_BIN: executable,
      OAR_CAPTURE_PATH: capture,
      OAR_FIXTURE_API_TOKEN: 'implicit-private-value',
      DSH_OAR_FIXTURE_ID: 'implicit-harness-value',
      OAR_FIXTURE_KEEP: 'ordinary-value',
      OAR_FIXTURE_EXPLICIT_TOKEN: 'implicit-token-value',
      OAR_FIXTURE_DELETE: 'remove-me',
      CLAUDECODE: 'parent',
      CLAUDE_CODE_SESSION_ID: 'parent-session',
      CLAUDE_CODE_CHILD_SESSION: 'parent-child',
      CLAUDE_CODE_HOST_WORKTREE_FENCE: 'parent-fence',
      TRACEPARENT: 'fixture-trace',
    },
  })
  const child = await execa(launch.command, launch.args, {
    cwd: root, env: launch.env, stdin: 'ignore', timeout: 45_000,
    cancelSignal: test.signal, killSignal: 'SIGKILL', reject: false,
  })
  expect(child.timedOut, child.stderr).toBe(false)
  expect(child.isCanceled, child.stderr).toBe(false)
  expect(child.signal, child.stderr).toBeUndefined()
  expect(child.exitCode, child.stderr).toBe(0)
  const observations = (await readFile(capture, 'utf8')).trim().split('\n')
    .map(line => JSON.parse(line) as Observation)
  expect(observations.filter(entry => entry.kind === 'probe')).toHaveLength(3)
  expect(observations.some(entry => entry.args.join(' ') === 'app-server --help')).toBe(true)
  expect(observations.filter(entry => entry.args.includes('--version'))).toHaveLength(2)
  for (const entry of observations) {
    expect(entry.environment.OAR_FIXTURE_API_TOKEN).toBeNull()
    expect(entry.environment.DSH_OAR_FIXTURE_ID).toBeNull()
    expect(entry.environment.OAR_FIXTURE_EXPLICIT_TOKEN).toBe('explicit-fixture-value')
    expect(entry.environment.OAR_FIXTURE_KEEP).toBe('ordinary-value')
    expect(entry.environment.OAR_FIXTURE_DELETE).toBeNull()
  }
  const session = observations.find(entry => entry.kind === 'session')
  expect(session).toBeDefined()
  expect(session?.environment).toMatchObject({
    CLAUDECODE: null, CLAUDE_CODE_SESSION_ID: null,
    CLAUDE_CODE_CHILD_SESSION: null, CLAUDE_CODE_HOST_WORKTREE_FENCE: null,
    TRACEPARENT: 'fixture-trace',
  })
})
