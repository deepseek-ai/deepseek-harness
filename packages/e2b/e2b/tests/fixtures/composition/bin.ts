import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { boot } from '@deepseek-ai/dsh-app-boot'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-fs-e2b'
import type {} from '@deepseek-ai/dsh-bash-local'
import type {} from '@deepseek-ai/dsh-lsp-stdio'
import type {} from '@deepseek-ai/dsh-terminal-bash'

const configPath = process.argv[2]
if (configPath === undefined) throw new Error('usage: bin.ts <cordis.yml>')

const ctx = await boot('e2b-composition', resolve(configPath))
const ownerFiber = ctx.plugin(() => {})
const ownerId = SessionId('e2b-live-owner')
const session = Session.create(ownerId)
const unsupportedInboxMutation = (): never => {
  throw new Error('the E2B composition owner does not support Inbox mutations')
}
const owner: Agent = {
  id: ownerId,
  options: {},
  session,
  inbox: {
    nextTurn: [],
    nextStep: [],
    clear: unsupportedInboxMutation,
    append: unsupportedInboxMutation,
    prepend: unsupportedInboxMutation,
    replace: unsupportedInboxMutation,
    remove: unsupportedInboxMutation,
    splice: unsupportedInboxMutation,
  },
  status: 'idle',
  ctx: ownerFiber.ctx,
  send() {},
  followup() {},
  steer() {},
  inject() {},
  cancel() {},
  runMaintenance: task => task(new AbortController().signal),
  whenIdle: () => Promise.resolve(),
}
const unregisterOwner = ctx.agents.register(owner)
let terminalId: Awaited<ReturnType<typeof ctx.terminals.spawn>>['sessionId'] | undefined
try {
  const sandbox = await ctx.e2b.getSandbox()
  const fromFs = await ctx.fs.resolve('from-fs.txt')
  const written = await ctx.fs.writeText(fromFs, 'written-by-fs\n', { kind: 'createIfAbsent' })
  const observed = await ctx.fs.stat(fromFs)
  if (observed?.version !== written.version) {
    throw new Error(`E2B rename did not preserve version metadata: ${JSON.stringify({ written, observed })}`)
  }
  await ctx.fs.editText(
    fromFs,
    { oldString: 'written-by-fs', newString: 'versioned-by-fs', replaceAll: false },
    { version: observed.version },
  )
  const bashRead = await ctx.shell.run(ctx.shell.resolve({ command: 'cat from-fs.txt' }))
  if (bashRead.exitCode !== 0 || bashRead.stdout.text !== 'versioned-by-fs\n') {
    throw new Error(`E2B Bash could not read the FS write: ${JSON.stringify(bashRead)}`)
  }

  const bashWrite = await ctx.shell.run(ctx.shell.resolve({ command: "printf 'written-by-bash\\n' > from-bash.txt" }))
  if (bashWrite.exitCode !== 0) {
    throw new Error(`E2B Bash could not write the shared filesystem: ${JSON.stringify(bashWrite)}`)
  }
  const fromBash = await ctx.fs.resolve('from-bash.txt')
  const fsRead = await ctx.fs.readText(fromBash)

  const environmentHandle = ctx.subprocess.spawn({
    argv: ['env'],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 65_536 }, stderr: { maxBytes: 4_096 } },
    graceMs: 500,
    env: {
      'FOO-BAR': 'hyphen-value',
      DSH_EXPLICIT: 'managed-value',
      TOKEN_EXPLICIT: 'credential-value',
    },
  })
  const environmentOutcome = await environmentHandle.done
  const environmentText = environmentHandle.collected.stdout?.readFrom(0).text
  if (environmentOutcome.exitCode !== 0 || environmentText === undefined) {
    throw new Error(`E2B subprocess environment probe failed: ${JSON.stringify(environmentOutcome)}`)
  }
  const environmentLines = new Set(environmentText.trimEnd().split('\n'))
  const explicitEnvironment = [
    'FOO-BAR=hyphen-value',
    'DSH_EXPLICIT=managed-value',
    'TOKEN_EXPLICIT=credential-value',
  ].every(entry => environmentLines.has(entry))
  if (!explicitEnvironment) throw new Error(`E2B subprocess dropped an explicit environment entry: ${environmentText}`)

  const splitUtf8Handle = ctx.subprocess.spawn({
    argv: ['bash', '-c', "printf '\\344'; sleep 0.05; printf '\\275'; sleep 0.05; printf '\\240'; sleep 0.05; printf '\\345'; sleep 0.05; printf '\\245'; sleep 0.05; printf '\\275'"],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 32 }, stderr: { maxBytes: 4_096 } },
    graceMs: 500,
    env: {},
  })
  const splitUtf8Outcome = await splitUtf8Handle.done
  const splitUtf8Output = splitUtf8Handle.collected.stdout?.readFrom(0).text
  if (splitUtf8Outcome.exitCode !== 0 || splitUtf8Output !== '你好') {
    throw new Error(`E2B subprocess corrupted split UTF-8 output: ${JSON.stringify({ splitUtf8Outcome, splitUtf8Output })}`)
  }

  const outputDrainStarted = Date.now()
  const outputDrainHandle = ctx.subprocess.spawn({
    argv: ['bash', '-c', "bash -c 'exec -a dsh-output-drain-descendant sleep 30' & printf 'leader-done\\n'"],
    cwd: process.cwd(),
    stdio: { stdin: 'ignore', stdout: { maxBytes: 64 }, stderr: { maxBytes: 4_096 } },
    graceMs: 250,
    env: {},
  })
  const outputDrainOutcome = await outputDrainHandle.done
  const outputDrainText = outputDrainHandle.collected.stdout?.readFrom(0).text
  const outputDrainElapsedMs = Date.now() - outputDrainStarted
  outputDrainHandle.terminate()
  const outputDrainExited = await outputDrainHandle.waitForExit(AbortSignal.timeout(5_000))
  const outputDrainProcesses = await sandbox.commands.list()
  const outputDrainClean = !outputDrainProcesses.some(processInfo =>
    JSON.stringify([processInfo.cmd, processInfo.args]).includes('dsh-output-drain-descendant'),
  )
  if (outputDrainOutcome.exitCode !== 0 || outputDrainText !== 'leader-done\n'
    || outputDrainElapsedMs >= 10_000 || !outputDrainExited || !outputDrainClean) {
    throw new Error(`E2B subprocess did not bound descendant-held output: ${JSON.stringify({
      outputDrainOutcome, outputDrainText, outputDrainElapsedMs, outputDrainExited, outputDrainClean,
    })}`)
  }

  const lspFixture = await readFile(new URL('./fixture-lsp.mjs', import.meta.url), 'utf8')
  const remoteLspFixture = await ctx.fs.resolve('fixture-lsp.mjs')
  await ctx.fs.writeText(remoteLspFixture, lspFixture, { kind: 'createIfAbsent' })
  const remoteSource = await ctx.fs.resolve('multibyte # file.ts')
  await ctx.fs.writeText(remoteSource, 'const café = "你好"\nconsole.log(café)\n', { kind: 'createIfAbsent' })
  const hover = await ctx.lsp.query({
    operation: 'hover',
    filePath: 'multibyte # file.ts',
    position: { line: 0, character: 7 },
    workspaceRoot: process.cwd(),
  })
  const definition = await ctx.lsp.query({
    operation: 'goToDefinition',
    filePath: 'multibyte # file.ts',
    position: { line: 0, character: 7 },
    workspaceRoot: process.cwd(),
  })

  const terminal = await ctx.terminals.spawn(owner, { type: 'shell' })
  terminalId = terminal.sessionId
  const terminalEcho = await ctx.terminals.startSend(owner, terminal.sessionId, {
    text: "printf 'PTY-你好\\n'",
    submit: true,
  }).done
  const sleeping = ctx.terminals.startSend(owner, terminal.sessionId, {
    text: "printf 'DSH_SLEEP_%s\\n' READY; sleep 30",
    submit: true,
  })
  let sleepReadyOutput = ''
  const sleepReadyDeadline = Date.now() + 5_000
  while (!sleepReadyOutput.includes('DSH_SLEEP_READY\n')) {
    sleepReadyOutput += sleeping.readOutput().delta
    if (sleepReadyOutput.includes('DSH_SLEEP_READY\n')) break
    const settled = await Promise.race([
      sleeping.done.then(result => ({ result })),
      new Promise<undefined>(resolveDelay => setTimeout(() => { resolveDelay(undefined) }, 25)),
    ])
    if (settled !== undefined) {
      throw new Error(`E2B PTY successor settled before executing: ${JSON.stringify(settled.result)}`)
    }
    if (Date.now() >= sleepReadyDeadline) throw new Error(`E2B PTY successor did not execute: ${sleepReadyOutput}`)
  }
  const terminalSignal = await ctx.terminals.signal(owner, terminal.sessionId, 'SIGINT')
  const interrupted = await sleeping.done
  const stubborn = await ctx.terminals.startSend(owner, terminal.sessionId, {
    text: "bash -c 'trap \"\" TERM; exec sleep 30' & printf 'DSH_STUBBORN_PID=%s\\n' \"$!\"",
    submit: true,
  }).done
  const stubbornMatch = /DSH_STUBBORN_PID=([1-9][0-9]*)/.exec(stubborn.viewport)
  if (stubbornMatch?.[1] === undefined) throw new Error(`E2B PTY did not report its stubborn child: ${stubborn.viewport}`)
  const stubbornPid = Number(stubbornMatch[1])
  const terminalScrollback = ctx.terminals.read(owner, terminal.sessionId, { count: 50 })
  await ctx.terminals.kill(owner, terminal.sessionId, 'live E2B composition complete')
  terminalId = undefined
  const stubbornProbe = await sandbox.commands.run(`if kill -0 ${stubbornPid} 2>/dev/null; then printf alive; else printf gone; fi`)
  const terminalTreeCleanup = stubbornProbe.stdout === 'gone'
  if (!terminalTreeCleanup) throw new Error(`E2B PTY left process ${stubbornPid} alive after close`)

  process.stdout.write(`${JSON.stringify({
    sandboxId: (await ctx.e2b.getSandbox()).sandboxId,
    bashRead: bashRead.stdout.text,
    fsRead,
    explicitEnvironment,
    splitUtf8Output,
    hover,
    definition,
    terminal: {
      motd: terminal.motd,
      echo: terminalEcho,
      signal: terminalSignal,
      interrupted,
      treeCleanup: terminalTreeCleanup,
      scrollback: terminalScrollback.text,
    },
  })}\n`)
} finally {
  if (terminalId !== undefined) await ctx.terminals.kill(owner, terminalId, 'fixture cleanup').catch(() => false)
  unregisterOwner()
  await ownerFiber.dispose()
  await ctx.fiber.dispose()
}
