import { access } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import {
  FileNotFoundError,
  Sandbox,
  SandboxNotFoundError,
} from '@deepseek-ai/dsh-e2b'
import TerminalSessionService, { TerminalSessionId } from '@deepseek-ai/dsh-terminal'
import { BashTerminalBackend } from '@deepseek-ai/dsh-terminal-bash'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import E2BSubprocessRuntime from '@deepseek-ai/dsh-subprocess-e2b'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'

const fixtureRoot = fileURLToPath(new URL('./fixtures/composition/', import.meta.url))
const binScript = join(fixtureRoot, 'bin.ts')
const configPath = join(fixtureRoot, 'cordis.yml')
const tsconfigPath = fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url))

describe.skipIf(!process.env.E2B_API_KEY)('E2B live Loader composition', () => {
  it('scrubs credentials before actual E2B command and PTY login shells', async () => {
    const apiKey = process.env.E2B_API_KEY
    if (apiKey === undefined) throw new Error('E2B_API_KEY disappeared before the PTY environment test')
    const sandbox = await Sandbox.create({
      apiKey,
      envs: { NPM_TOKEN: 'sentinel-secret', DSH_STALE: 'sentinel-stale', KEEP: 'visible' },
      timeoutMs: 60_000,
      secure: true,
      lifecycle: { onTimeout: 'kill' },
    })
    try {
      const profileLeakPath = '/home/user/dsh-e2b-bootstrap-profile-leak'
      const hostileProfile = [
        'if [[ "${NPM_TOKEN-}" == "sentinel-secret" ]]; then',
        `  printf leaked > ${profileLeakPath}`,
        'fi',
        '',
      ].join('\n')
      await sandbox.files.write([
        { path: '/home/user/.bash_profile', data: hostileProfile },
        { path: '/home/user/.profile', data: hostileProfile },
        { path: '/home/user/.bashrc', data: hostileProfile },
      ])
      const ctx = new Context()
      ctx.provide('e2b', {
        cwd: '/home/user',
        runtimeRoot: '/home/user/.dsh-e2b',
        getSandbox: async () => sandbox,
      } as never)
      await ctx.plugin(SessionProjectionRegistry)
      const sandboxPolicyFiber = await ctx.plugin(SandboxPolicyService, {
        mode: 'danger-full-access',
        workspaceRoot: '/home/user',
      })
      const ptyFiber = await ctx.plugin(TerminalSessionService)
      const subprocessFiber = await ctx.plugin(E2BSubprocessRuntime)
      const node = await ctx.subprocess.resolveExecutable('node')
      const relativeNodePath = posix.relative(ctx.e2b.cwd, posix.dirname(node)) || '.'
      await expect(ctx.subprocess.resolveExecutable('node', { PATH: relativeNodePath })).resolves.toBe(node)
      await expect(sandbox.files.read(profileLeakPath)).rejects.toBeInstanceOf(FileNotFoundError)
      const environmentProbe = ctx.subprocess.spawn({
        argv: ['/bin/bash', '-c', [
          'dsh_leak=0',
          'for dsh_pid in "$PPID" $(ps -o pid= --ppid "$PPID"); do',
          '  [[ "$dsh_pid" == "$$" ]] && continue',
          '  if tr "\\0" "\\n" < "/proc/$dsh_pid/environ" 2>/dev/null | grep -Fqx "NPM_TOKEN=sentinel-secret"; then dsh_leak=1; fi',
          'done',
          'printf "DIRECT=<%s> LEAK=<%s>\\n" "${NPM_TOKEN-}" "$dsh_leak"',
        ].join('\n')],
        cwd: '/home/user',
        stdio: { stdin: 'ignore', stdout: { maxBytes: 1_024 }, stderr: { maxBytes: 1_024 } },
        graceMs: 500,
        env: {},
      })
      await expect(environmentProbe.done).resolves.toEqual({ exitCode: 0, signal: null })
      expect(environmentProbe.collected.stdout?.readFrom(0).text).toBe('DIRECT=<> LEAK=<0>\n')
      await expect(sandbox.files.read(profileLeakPath)).rejects.toBeInstanceOf(FileNotFoundError)
      const ownerId = SessionId('e2b-pty-env-owner')
      const ownerSession = Session.create(ownerId)
      const owner: Agent = {
        id: ownerId,
        options: {},
        session: ownerSession,
        inbox: unsupportedInbox(),
        status: 'idle',
        ctx,
        send() {},
        followup() {},
        steer() {},
        inject() {},
        cancel() {},
        runMaintenance: task => task(new AbortController().signal),
        whenIdle: () => Promise.resolve(),
      }
      const backend = new BashTerminalBackend(ctx, {
        backendType: 'shell', shellDialect: 'bash', shellPath: '/bin/bash', shellArgs: ['--noprofile', '--norc', '-i'],
        rows: 24, cols: 80,
        scrollbackLines: 100, scrollbackMaxBytes: 65_536, maxReadBytes: 16_384,
        pollIntervalMs: 25, exactProbeAfterMs: 150, idleSilenceMs: 1_000,
        handoffGraceMs: 500, timeoutMs: 5_000, disposeGraceMs: 1_000,
      })
      const session = await backend.spawn({ sessionId: TerminalSessionId('env'), owner, type: 'shell' })
      const result = await session.startSend({
        text: "printf 'NPM=<%s> DSH=<%s> KEEP=<%s>\\n' \"$NPM_TOKEN\" \"$DSH_STALE\" \"$KEEP\"",
        submit: true,
      }).done
      expect(result.viewport).toContain('NPM=<> DSH=<> KEEP=<visible>')
      expect(result.viewport).not.toContain('sentinel-secret')
      expect(result.viewport).not.toContain('sentinel-stale')
      await expect(sandbox.files.read(profileLeakPath)).rejects.toBeInstanceOf(FileNotFoundError)
      await session.close('environment test complete')
      await subprocessFiber.dispose()
      await ptyFiber.dispose()
      await sandboxPolicyFiber.dispose()

    } finally {
      await sandbox.kill().catch(() => false)
    }
  }, 70_000)

  it('runs FS, Bash, PTY, and LSP in one sandbox and deletes it', async () => {
    const { stdout, stderr } = await runLoaderSmoke({
      label: 'E2B composition',
      tempDirPrefix: 'dsh-e2b-composition-',
      binScript,
      libBinScript: binScript,
      configPath,
      tsconfigPath,
      env: {
        NODE_OPTIONS: [process.env.NODE_OPTIONS, '--disable-warning=ExperimentalWarning'].filter(Boolean).join(' '),
      },
      processTimeoutMs: 180_000,
      inspect: async (cwd) => {
        for (const name of ['from-fs.txt', 'from-bash.txt', 'multibyte # file.ts', 'fixture-lsp.mjs']) {
          await expect(access(join(cwd, name))).rejects.toMatchObject({ code: 'ENOENT' })
        }
      },
    })

    expect(stderr).toBe('')
    const output = JSON.parse(stdout) as Record<string, unknown>
    expect(output).toMatchObject({
      bashRead: 'versioned-by-fs\n',
      fsRead: 'written-by-bash\n',
      explicitEnvironment: true,
      splitUtf8Output: '你好',
      hover: {
        kind: 'hover',
        hover: { contents: '**remote hover** 你好 café' },
      },
      definition: {
        kind: 'locations',
        locations: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } } }],
      },
      terminal: {
        echo: { waitReason: 'stdin_read', sessionStatus: { kind: 'running' } },
        signal: { delivered: true },
        interrupted: { sessionStatus: { kind: 'running' } },
        treeCleanup: true,
      },
    })
    const terminalMotd = (output.terminal as { motd: string }).motd
    expect(terminalMotd.length).toBeGreaterThan(0)
    expect(terminalMotd).not.toContain('exec /bin/bash')
    expect(terminalMotd).not.toContain('.dsh-e2b/terminals/')
    expect((output.terminal as { echo: { viewport: string } }).echo.viewport).toContain('PTY-你好')
    expect((output.terminal as { scrollback: string }).scrollback).toContain('PTY-你好')
    expect((output.terminal as { signal: { targetPgid: number } }).signal.targetPgid).toBeGreaterThan(0)
    expect(['stdin_read', 'inferred_idle']).toContain(
      (output.terminal as { interrupted: { waitReason: string } }).interrupted.waitReason,
    )
    const apiKey = process.env.E2B_API_KEY
    if (apiKey === undefined) throw new Error('E2B_API_KEY disappeared during the live composition test')
    await expect(Sandbox.getInfo(String(output.sandboxId), { apiKey })).rejects.toBeInstanceOf(SandboxNotFoundError)
    await expect.poll(async () => {
      const sandboxes = await Sandbox.list({ apiKey }).nextItems()
      return sandboxes.some(sandbox => sandbox.sandboxId === output.sandboxId)
    }, { interval: 250, timeout: 5_000 }).toBe(false)
  }, 195_000)
})
