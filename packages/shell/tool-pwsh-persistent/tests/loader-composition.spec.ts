import { spawnSync } from 'node:child_process'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { release, tmpdir, version } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, onTestFailed, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { Agent } from '@deepseek-ai/dsh-agent'
import TerminalSessionService from '@deepseek-ai/dsh-terminal'
import type { TerminalWaitReason } from '@deepseek-ai/dsh-terminal'
import * as TerminalBash from '@deepseek-ai/dsh-terminal-bash'
import SandboxProvider from '@deepseek-ai/dsh-sandbox'
import type { ConfinedArgv, SandboxPolicy } from '@deepseek-ai/dsh-sandbox'
import SandboxPolicyService from '@deepseek-ai/dsh-sandbox-policy'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local/src/resolve.ts'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import * as ToolPwshPersistent from '@deepseek-ai/dsh-tool-pwsh-persistent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ReadinessTimeline, TIMELINE_HEADER } from './readiness-timeline.ts'

const pwshPath = resolvePwshPath()
const hasPwsh = spawnSync(
  pwshPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$true'],
  { encoding: 'utf8' },
).status === 0

// Shell and console-host versions for a failure message: the Windows console host, not this
// process, decides how the prompt marker and its tail reach the session, and its build on the
// self-hosted pool is unknown.
const HOST_FACTS_COMMAND = [
  '"pwsh $($PSVersionTable.PSVersion) PSReadLine $((Get-Module PSReadLine -ListAvailable | Sort-Object Version -Descending | Select-Object -First 1).Version)"',
  'if ($env:OS -eq \'Windows_NT\') { "conhost $((Get-Item (Join-Path $env:SystemRoot \'System32\\conhost.exe\')).VersionInfo.FileVersion)" }',
].join('; ')

function hostFacts(): string {
  const probe = spawnSync(
    pwshPath, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', HOST_FACTS_COMMAND],
    { encoding: 'utf8', timeout: 30_000 },
  )
  const shell = probe.status === 0
    ? probe.stdout.trim().split(/\r?\n/).join('; ')
    : `version probe failed: ${probe.error?.message ?? probe.stderr.trim()}`
  return [
    `host: ${process.platform} ${process.arch} ${release()} (${version()}); node ${process.version}`,
    `shell: ${pwshPath}; ${shell}`,
    // dsh-subprocess-local spawns node-pty without useConptyDll, so the system console host,
    // not the OpenConsole build node-pty bundles, renders every session.
    'conpty: system conhost',
  ].join('\n')
}

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  vi.restoreAllMocks()
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

class PassthroughSandbox extends SandboxProvider {
  async confine(argv: readonly string[], _policy: SandboxPolicy): Promise<ConfinedArgv> {
    return { argv: [...argv], enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
  }
}

async function agent(ctx: Context, cwd: string): Promise<Agent> {
  const id = SessionId('persistent-pwsh-loader-agent')
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd, isSeeded: false,
  })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  await ctx.agents.register(value)
  return value
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

describe.skipIf(!hasPwsh)('persistent pwsh through a real cordis.yml Loader composition', () => {
  it('preserves cwd and environment across calls', async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'dsh-persistent-pwsh-loader-')))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-terminal'",
      "- name: '@deepseek-ai/dsh-test-sandbox'",
      "- name: '@deepseek-ai/dsh-session-projection'",
      "- name: '@deepseek-ai/dsh-sandbox-policy'",
      '  config:',
      '    mode: danger-full-access',
      `    workspaceRoot: ${JSON.stringify(root)}`,
      "- name: '@deepseek-ai/dsh-subprocess-local'",
      "- name: '@deepseek-ai/dsh-terminal-bash'",
      '  config:',
      '    shellDialect: pwsh',
      '    pollIntervalMs: 10',
      '    exactProbeAfterMs: 20',
      // The silence tier keeps its product default; the case body records each
      // send's wait reason, which pins the controlled-prompt fast path directly
      // instead of relying on how long silence would take to settle.
      '    handoffGraceMs: 300',
      // promptTailGraceMs keeps its product default (0): the self-hosted Windows failures of
      // 2026-09-25..27 settled at the plain silence bound with the tolerance present and absent
      // alike, so it never applied there and would only lengthen a never-arriving-tail fallback.
      '    scrollbackLines: 20000',
      // The first call pays the full pwsh cold-start latency (spawn + .NET +
      // PSReadLine + Defender) inside the tool deadline; a 60s bound on the
      // fully loaded self-hosted Windows pool is exceeded often enough to
      // reset the session mid-test (2026-09-01, two runs ~62s each). 300s
      // matches the dsh-tool-pwsh-persistent product default; the
      // dsh-terminal-bash value bounds one send plus the complete startup
      // sequence, so it covers the same cold start (its 30s product default
      // would not).
      '    timeoutMs: 300000',
      '    disposeGraceMs: 500',
      "- name: '@deepseek-ai/dsh-tool-pwsh-persistent'",
      '  config:',
      '    timeoutMs: 300000',
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
      ['@deepseek-ai/dsh-tools', ToolRegistry],
      ['@deepseek-ai/dsh-terminal', TerminalSessionService],
      ['@deepseek-ai/dsh-test-sandbox', PassthroughSandbox],
      ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
      ['@deepseek-ai/dsh-sandbox-policy', SandboxPolicyService],
      ['@deepseek-ai/dsh-subprocess-local', LocalSubprocessService],
      ['@deepseek-ai/dsh-terminal-bash', TerminalBash],
      ['@deepseek-ai/dsh-tool-pwsh-persistent', ToolPwshPersistent],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    const terminals = context.terminals
    const startSend = terminals.startSend.bind(terminals)
    // A send that lost the controlled-prompt fast path settles as inferred_idle
    // after the silence tier, so recording why every send settled detects that
    // regression immediately instead of through accumulated wall-clock. The
    // timeline records what the session observed on the way there — every pty
    // chunk's prompt verdict, every foreground poll, every write — because the
    // reason alone cannot say whether the marker was missing, its tail was
    // invalidated by later output, or the foreground comparison failed.
    const timeline = new ReadinessTimeline(hostFacts)
    timeline.observeSanitizer()
    const spawnTerminal = context.subprocess.spawnTerminal.bind(context.subprocess)
    vi.spyOn(context.subprocess, 'spawnTerminal').mockImplementation(async (spec) => {
      const handle = await spawnTerminal(spec)
      timeline.observeTerminal(handle)
      return handle
    })
    const settleReasons: TerminalWaitReason[] = []
    vi.spyOn(terminals, 'startSend').mockImplementation((owner, id, request) => {
      const operation = startSend(owner, id, request)
      timeline.track(operation, request)
      void operation.done.then(
        (settled) => { settleReasons.push(settled.waitReason) },
        // A rejected send is the tool's error path, not a settle reason.
        () => {},
      )
      return operation
    })
    // The runner's timeout never reaches the assertions below; print the timeline
    // for that path too, unless a failed assertion already carries it.
    onTestFailed(({ task }) => {
      if (task.result?.errors?.some(error => error.message?.includes(TIMELINE_HEADER))) return
      console.error(timeline.format())
    })

    const owner = await agent(context, root)
    const signal = new AbortController().signal
    const execute = (id: string, command: string) => {
      timeline.label(id)
      return context!.tools.execute({
        signal,
        callId: ToolCallId(id),
        name: 'pwsh',
        arguments: { command },
        agent: owner,
      })
    }

    expect(context.tools.schemas().map(schema => schema.name)).toEqual(['pwsh'])
    await execute('state', '$env:KEEP = "loader"; New-Item -ItemType Directory -Force -Path nested | Out-Null; Set-Location nested')
    const observed = text(await execute('observe', 'Write-Output "cwd=$PWD keep=$env:KEEP"'))
    expect(observed).toContain(`cwd=${join(root, 'nested')} keep=loader`)
    expect(observed).not.toContain('DSH_PERSISTENT_PWSH')

    const multiline = text(await execute(
      'multiline',
      '$value = "line one"\nWrite-Output "${value}:it\'s fine"',
    ))
    expect(multiline).toBe("line one:it's fine")
    expect(multiline).not.toContain('DSH_PERSISTENT_PWSH')

    const hereString = text(await execute(
      'here-string',
      "$h = @'\nalpha\nbeta\n'@\nWrite-Output $h",
    ))
    expect(hereString).toBe('alpha\nbeta')

    const large = text(await execute('large-output', '1..12050 | ForEach-Object { $_ }'))
    expect(large.startsWith('1\n2\n3\n')).toBe(true)
    expect(large).toContain('<response clipped>')
    expect(large).not.toContain('beginning of this command output was dropped')

    const exited = text(await execute('exit', 'exit'))
    expect(exited).toContain('next pwsh call starts from the workspace')
    expect(text(await execute('after-exit', 'Write-Output "$PWD"'))).toBe(root)

    // Six commands settle on the controlled prompt; no send may fall back to the
    // silence tier, which is the 3.3 s-per-call degradation this suite pins. The
    // counts alone do not say which tier settled which send, so every reason the
    // run recorded and the per-send timeline ride in the failure message (the
    // self-hosted Windows lane reported one to two stdin_read settlements per
    // run on 2026-09-25..27, every other send at the plain silence bound). The
    // message is built only when an assertion is about to fail: formatting runs
    // the host-facts shell probe, which a passing run must not pay for.
    const stdinReads = settleReasons.filter(reason => reason === 'stdin_read').length
    const degraded = stdinReads < 6 || settleReasons.includes('inferred_idle')
    const failure = degraded ? `${JSON.stringify(settleReasons)}\n${timeline.format()}` : ''
    expect(stdinReads, failure).toBeGreaterThanOrEqual(6)
    expect(settleReasons, failure).not.toContain('inferred_idle')
  }, 120_000)
})
