import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { delimiter, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { runScenario, snapshotSpillRoot, type AgentUnderTest, type InputStep } from '../src/harness.ts'
import { launchAcpTestAgent } from '../src/launcher.ts'

const fsControl = vi.hoisted(() => ({ cleanupFailure: undefined as Error | undefined }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    async rm(...args: Parameters<typeof actual.rm>): Promise<void> {
      if (String(args[0]).includes('acp-snap-cwd-') && fsControl.cleanupFailure !== undefined) {
        const failure = fsControl.cleanupFailure
        fsControl.cleanupFailure = undefined
        await actual.rm(...args)
        throw failure
      }
      await actual.rm(...args)
    },
  }
})

/**
 * Unit tests for the subprocess harness, driven through the REAL spawn path
 * (mode-aware launcher, temp cwd, env plumbing) against the scripted fake ACP bin in
 * ./fixtures/fake-acp-agent.ts. Each case writes a `behavior.json` next to a
 * throwaway fixture path; the fake bin echoes observable facts (env, seeded
 * workspace, permission outcomes) into `agent_message_chunk` text, so the
 * assertions read plain `rawStdout`.
 */

const fakeAgent = fileURLToPath(new URL('./fixtures/fake-acp-agent.ts', import.meta.url))
const AGENT: AgentUnderTest = {
  binScript: fakeAgent,
  libBinScript: fakeAgent,
  // The fake bin ignores its config argv; any real path documents the shape.
  configPath: fakeAgent,
  tsconfigPath: fileURLToPath(new URL('../../../../tsconfig.json', import.meta.url)),
}

async function materializedPatch(root: string, filename: string): Promise<string> {
  const entries = await readdir(root, { recursive: true })
  const matches = entries.filter(entry => entry.endsWith(filename))
  expect(matches).toHaveLength(1)
  return join(root, matches[0] as string)
}

/** Temp scenario dirs to drop after the suite. */
const tempDirs: string[] = []
afterAll(async () => {
  for (const dir of tempDirs) await rm(dir, { recursive: true, force: true })
})

/** Write a behavior.json into a fresh temp dir; return the sibling fixture path the harness points the bin at. */
async function scenario(behavior: object): Promise<{ dir: string; fixtureFile: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'acp-snap-spec-'))
  tempDirs.push(dir)
  await writeFile(join(dir, 'behavior.json'), JSON.stringify(behavior))
  return { dir, fixtureFile: join(dir, 'session.jsonl') }
}

const boot: InputStep[] = [{ op: 'initialize' }, { op: 'newSession' }]
// A Windows coverage shard can spend more than 20ms harvesting logs before vi.waitFor records the diagnostic error.
const titleDiagnosticTimeoutMs = process.platform === 'win32' ? 5_000 : 20

it('keeps scenario-owned snapshot spill root length stable across platforms', () => {
  const fixtureFile = '/fixtures/scenario/session.jsonl'
  const posix = snapshotSpillRoot(fixtureFile, 'linux')
  const windows = snapshotSpillRoot(fixtureFile, 'win32')
  expect(posix).toMatch(/^\/tmp\/dsh-acp-snap-[0-9a-f]{9}$/)
  expect(windows).toMatch(/^\/t\/dsh-acp-snap-[0-9a-f]{9}$/)
  expect(windows.length + 2).toBe(posix.length)
})

function environmentEcho(rawStdout: string): Record<string, unknown> {
  const frames = rawStdout.trim().split('\n')
    .map(line => JSON.parse(line) as { params?: { update?: { content?: { text?: unknown } } } })
  const text = frames.map(frame => frame.params?.update?.content?.text)
    .find(value => typeof value === 'string' && value.startsWith('env:'))
  if (typeof text !== 'string') throw new Error('fake ACP agent did not echo its environment')
  return JSON.parse(text.slice('env:'.length)) as Record<string, unknown>
}

describe('runScenario', () => {
  it('surfaces an asynchronous child spawn failure through startup and close', async () => {
    const { dir } = await scenario({})
    const launched = launchAcpTestAgent({ agent: AGENT, cwd: join(dir, 'missing') })
    let stdioClosed = false
    let clientClosed = false
    launched.child.once('close', () => { stdioClosed = true })
    void launched.client.closed.then(
      () => { clientClosed = true },
      () => { clientClosed = true },
    )
    await expect(launched.spawned).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(launched.close()).rejects.toMatchObject({ code: 'ENOENT' })
    expect(stdioClosed).toBe(true)
    expect(clientClosed).toBe(true)
  })

  it('centralizes ACP boot, captures, updates, fail-closed permissions, and shutdown', { timeout: 20_000 }, async () => {
    const { dir, fixtureFile } = await scenario({ permissionProbe: true, echoEnv: true, stderrNote: 'launcher stderr' })
    const sessionsRoot = await mkdtemp(join(tmpdir(), 'acp-launcher-sessions-'))
    tempDirs.push(sessionsRoot)
    const launched = launchAcpTestAgent({
      agent: AGENT,
      cwd: dir,
      configPath: AGENT.configPath,
      env: {
        DSH_SNAPSHOT: 'replay',
        DSH_SNAPSHOT_FILE: fixtureFile,
        DSH_SNAPSHOT_SESSIONS_ROOT: sessionsRoot,
      },
    })
    await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await launched.client.newSession({ cwd: dir, mcpServers: [] })
    const nextChunk = launched.waitForUpdate(update => update.sessionUpdate === 'agent_message_chunk')
    const laterChunk = launched.waitForUpdate(update => update.sessionUpdate === 'agent_message_chunk'
      && update.content.type === 'text' && update.content.text === 'never this one')
    const predicateFailure = new Error('predicate failed')
    const failedPredicate = launched.waitForUpdate(() => { throw predicateFailure })
      .catch((error: unknown): unknown => error)
    await launched.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] })
    expect(await failedPredicate).toBe(predicateFailure)
    expect((await nextChunk).sessionUpdate).toBe('agent_message_chunk')
    expect(launched.updates.some(update => update.sessionUpdate === 'agent_message_chunk')).toBe(true)
    expect(launched.rawStdout()).toContain('permission:{\\"outcome\\":\\"cancelled\\"}')
    expect(launched.stderr()).toContain('launcher stderr')
    void laterChunk.catch(() => undefined)
    const unmatched = expect(launched.waitForUpdate(() => false)).rejects.toThrow(/update stream closed/)
    await launched.close()
    await unmatched
    await expect(launched.waitForUpdate(() => true)).rejects.toThrow(/update stream closed/)
    await launched.close('SIGKILL')

    // The minimal shape needs no environment or config override.
    const minimal = launchAcpTestAgent({ agent: AGENT, cwd: dir })
    await minimal.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const childFailure = new Error('child process failed')
    let exited = false
    minimal.child.once('exit', () => { exited = true })
    minimal.child.emit('error', childFailure)
    await expect(minimal.close('SIGTERM')).rejects.toBe(childFailure)
    // close rejects only after the fallback SIGKILL has produced an exit edge.
    expect(exited).toBe(true)
  })

  it('builds dsh profile argv and rebases relative modules in live and replay patches', async () => {
    const { dir, fixtureFile } = await scenario({})
    const patchDir = join(dir, 'patches')
    const basePatch = join(patchDir, 'base.cordis.yml')
    const selectedPatch = join(patchDir, 'selected.cordis.yml')
    const replayPatch = join(patchDir, 'selected.cordis.snapshot.yml')
    const packageDir = join(dir, 'node_modules', 'example-package')
    const scopedPackageDir = join(dir, 'node_modules', '@fixture', 'example-package')
    await Promise.all([
      mkdir(patchDir, { recursive: true }),
      mkdir(packageDir, { recursive: true }),
      mkdir(scopedPackageDir, { recursive: true }),
    ])
    await Promise.all([
      writeFile(basePatch, [
        '- id: asserted',
        '  name: ./plugin.mjs',
        '  disabled: true',
        '- insert:',
        '    - id: relative',
        '      name: ./plugin.mjs',
        '    - id: package',
        '      name: example-package',
        '    - id: scoped-package',
        "      name: '@fixture/example-package/subpath'",
        '    - id: builtin',
        '      name: fs',
        '    - id: group',
        '      name: cordis:group',
        '      group: true',
        '      config:',
        '        - id: nested',
        '          name: ../nested.mjs',
        '',
      ].join('\n')),
      writeFile(selectedPatch, '[]\n'),
      writeFile(replayPatch, '[]\n'),
      writeFile(join(patchDir, 'plugin.mjs'), 'export function apply() {}\n'),
      writeFile(join(packageDir, 'package.json'), '{"name":"example-package","version":"1.0.0"}\n'),
      writeFile(join(scopedPackageDir, 'package.json'), '{"name":"@fixture/example-package","version":"1.0.0"}\n'),
    ])
    const profileAgent: AgentUnderTest = { ...AGENT, configPath: basePatch, profile: 'acp' }

    const live = launchAcpTestAgent({
      agent: profileAgent,
      cwd: dir,
      configPath: selectedPatch,
      env: { DSH_SNAPSHOT: 'record', DSH_SNAPSHOT_FILE: fixtureFile },
    })
    await live.spawned
    await live.close()
    const materializedRoot = join(dir, '.dsh-profile-patches')
    const materialized = await readFile(await materializedPatch(materializedRoot, '0-base.cordis.yml'), 'utf8')
    expect(materialized).toContain(pathToFileURL(join(patchDir, 'plugin.mjs')).href)
    expect(materialized).toContain(pathToFileURL(join(dir, 'nested.mjs')).href)
    expect(materialized).toContain('example-package')
    expect(await realpath(join(dir, '.dsh', 'profiles', 'node_modules', 'example-package')))
      .toBe(await realpath(packageDir))
    expect(await realpath(join(dir, '.dsh', 'profiles', 'node_modules', '@fixture', 'example-package')))
      .toBe(await realpath(scopedPackageDir))
    expect(await readFile(await materializedPatch(materializedRoot, '1-selected.cordis.yml'), 'utf8')).toContain('[]')

    const replay = launchAcpTestAgent({
      agent: profileAgent,
      cwd: dir,
      configPath: selectedPatch,
      env: { DSH_SNAPSHOT: 'replay', DSH_SNAPSHOT_FILE: fixtureFile },
    })
    await replay.spawned
    await replay.close()
    expect(await readFile(await materializedPatch(materializedRoot, '1-selected.cordis.snapshot.yml'), 'utf8'))
      .toContain('[]')
    expect((await readdir(materializedRoot, { withFileTypes: true })).filter(entry => entry.isDirectory()))
      .toHaveLength(2)

    const conflictPatch = join(dir, 'conflict.cordis.yml')
    const conflictPackage = join(dir, 'node_modules', 'conflict-package')
    const otherPackage = join(dir, 'other-conflict-package')
    const conflictLink = join(dir, '.dsh', 'profiles', 'node_modules', 'conflict-package')
    await Promise.all([
      mkdir(conflictPackage, { recursive: true }),
      mkdir(otherPackage, { recursive: true }),
      writeFile(conflictPatch, '- id: conflict\n  name: conflict-package\n'),
    ])
    await Promise.all([
      writeFile(join(conflictPackage, 'package.json'), '{"name":"conflict-package","version":"1.0.0"}\n'),
      writeFile(join(otherPackage, 'package.json'), '{"name":"conflict-package","version":"2.0.0"}\n'),
    ])
    await symlink(otherPackage, conflictLink, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => launchAcpTestAgent({
      agent: { ...profileAgent, configPath: conflictPatch },
      cwd: dir,
      env: { DSH_SNAPSHOT: 'record', DSH_SNAPSHOT_FILE: fixtureFile },
    })).toThrow('snapshot profile package conflict-package resolves to two directories')

    const invalidPatch = join(dir, 'invalid.cordis.yml')
    await writeFile(invalidPatch, 'not: a-list\n')
    expect(() => launchAcpTestAgent({
      agent: { ...profileAgent, configPath: invalidPatch },
      cwd: dir,
      env: { DSH_SNAPSHOT: 'record', DSH_SNAPSHOT_FILE: fixtureFile },
    })).toThrow(`snapshot profile patch must be a top-level array: ${invalidPatch}`)
  })

  it('waits for inherited stdio and buffered ACP parsing after the parent exits', { timeout: 20_000 }, async () => {
    const { dir, fixtureFile } = await scenario({ lateInheritedOutput: true })
    const launched = launchAcpTestAgent({
      agent: AGENT,
      cwd: dir,
      env: { DSH_SNAPSHOT_FILE: fixtureFile },
    })
    await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    await launched.client.newSession({ cwd: dir, mcpServers: [] })
    const lateUpdate = launched.waitForUpdate(update =>
      update.sessionUpdate === 'agent_message_chunk'
      && update.content.type === 'text'
      && update.content.text === 'late inherited stdout')
    // Arm rejection handling before close may exhaust the stream; the later assertion still
    // observes the original promise and turns a missing inherited frame into the test failure.
    void lateUpdate.catch(() => undefined)

    await launched.close()

    await expect(lateUpdate).resolves.toMatchObject({ sessionUpdate: 'agent_message_chunk' })
    expect(launched.rawStdout()).toContain('late inherited stdout')
    expect(launched.stderr()).toContain('late inherited stderr')
  })

  it('rejects promptly when fallback termination is refused', async () => {
    const { dir } = await scenario({})
    const launched = launchAcpTestAgent({ agent: AGENT, cwd: dir })
    await launched.spawned

    const childFailure = Object.assign(new Error('signal refused'), { code: 'EPERM' })
    const originalKill = launched.child.kill.bind(launched.child)
    const kill = vi.spyOn(launched.child, 'kill').mockReturnValue(false)
    const closed = new Promise<void>(resolve => launched.child.once('close', () => { resolve() }))
    try {
      launched.child.emit('error', childFailure)
      const rejection = await launched.close('SIGTERM').catch((error: unknown): unknown => error)
      expect(rejection).toBeInstanceOf(AggregateError)
      expect(rejection).toMatchObject({
        message: 'ACP test agent failed and fallback termination was refused',
        errors: [
          childFailure,
          expect.objectContaining({ message: 'Fallback SIGKILL was not accepted by the child process' }),
        ],
      })
      expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    } finally {
      kill.mockRestore()
      originalKill('SIGKILL')
      await closed
    }
  })

  it('preserves the child error when the requested signal sets an exit marker', async () => {
    const { dir } = await scenario({})
    const launched = launchAcpTestAgent({ agent: AGENT, cwd: dir })
    await launched.spawned

    const childFailure = Object.assign(new Error('signal failed as the child exited'), { code: 'EPERM' })
    const originalKill = launched.child.kill.bind(launched.child)
    const kill = vi.spyOn(launched.child, 'kill').mockImplementation((signal) => {
      expect(signal).toBe('SIGTERM')
      originalKill('SIGKILL')
      Object.defineProperty(launched.child, 'signalCode', { configurable: true, enumerable: true, writable: true, value: 'SIGTERM' })
      return true
    })
    try {
      launched.child.emit('error', childFailure)
      await expect(launched.close('SIGTERM')).rejects.toBe(childFailure)
      expect(kill).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
      if (launched.child.exitCode === null && launched.child.signalCode === null) originalKill('SIGKILL')
    }
  })

  it('preserves the child error when the requested signal publishes its exit marker later', async () => {
    const { dir } = await scenario({})
    const launched = launchAcpTestAgent({ agent: AGENT, cwd: dir })
    await launched.spawned

    const childFailure = Object.assign(new Error('signal failed before the delayed exit marker'), { code: 'EPERM' })
    const originalKill = launched.child.kill.bind(launched.child)
    const kill = vi.spyOn(launched.child, 'kill').mockImplementation((signal) => {
      expect(signal).toBe('SIGTERM')
      setTimeout(() => { originalKill('SIGKILL') }, 10)
      return true
    })
    try {
      launched.child.emit('error', childFailure)
      await expect(launched.close('SIGTERM')).rejects.toBe(childFailure)
      expect(kill).toHaveBeenCalledOnce()
    } finally {
      kill.mockRestore()
      if (launched.child.exitCode === null && launched.child.signalCode === null) originalKill('SIGKILL')
    }
  })

  it('preserves the child error when fallback refusal races with an exit marker', async () => {
    const { dir } = await scenario({})
    const launched = launchAcpTestAgent({ agent: AGENT, cwd: dir })
    await launched.spawned

    const childFailure = Object.assign(new Error('signal failed while the child exited'), { code: 'EPERM' })
    const originalKill = launched.child.kill.bind(launched.child)
    const kill = vi.spyOn(launched.child, 'kill').mockImplementation((signal) => {
      if (signal === 'SIGTERM') return true
      originalKill('SIGKILL')
      Object.defineProperty(launched.child, 'signalCode', { configurable: true, enumerable: true, writable: true, value: 'SIGKILL' })
      return false
    })
    try {
      launched.child.emit('error', childFailure)
      await expect(launched.close('SIGTERM')).rejects.toBe(childFailure)
      expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    } finally {
      kill.mockRestore()
      if (launched.child.exitCode === null && launched.child.signalCode === null) originalKill('SIGKILL')
    }
  })

  it('preserves the child error after accepted fallback termination drains', async () => {
    const { dir } = await scenario({})
    const launched = launchAcpTestAgent({ agent: AGENT, cwd: dir })
    await launched.spawned

    const childFailure = Object.assign(new Error('requested signal failed before fallback'), { code: 'EPERM' })
    const originalKill = launched.child.kill.bind(launched.child)
    const kill = vi.spyOn(launched.child, 'kill').mockImplementation((signal) => {
      if (signal === 'SIGTERM') return true
      return originalKill('SIGKILL')
    })
    try {
      launched.child.emit('error', childFailure)
      await expect(launched.close('SIGTERM')).rejects.toBe(childFailure)
      expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    } finally {
      kill.mockRestore()
      if (launched.child.exitCode === null && launched.child.signalCode === null) originalKill('SIGKILL')
    }
  })

  it('rejects promptly when fallback termination emits an error', async () => {
    const { dir } = await scenario({})
    const launched = launchAcpTestAgent({ agent: AGENT, cwd: dir })
    await launched.spawned

    const childFailure = Object.assign(new Error('signal refused'), { code: 'EPERM' })
    const fallbackFailure = Object.assign(new Error('fallback signal refused'), { code: 'EPERM' })
    const originalKill = launched.child.kill.bind(launched.child)
    const kill = vi.spyOn(launched.child, 'kill').mockImplementation((signal) => {
      if (signal === 'SIGKILL') queueMicrotask(() => launched.child.emit('error', fallbackFailure))
      return signal === 'SIGKILL'
    })
    const closed = new Promise<void>(resolve => launched.child.once('close', () => { resolve() }))
    try {
      launched.child.emit('error', childFailure)
      const rejection = await launched.close('SIGTERM').catch((error: unknown): unknown => error)
      expect(rejection).toBeInstanceOf(AggregateError)
      expect(rejection).toMatchObject({
        message: 'ACP test agent failed and fallback termination was refused',
        errors: [childFailure, fallbackFailure],
      })
      expect(kill).toHaveBeenNthCalledWith(1, 'SIGTERM')
      expect(kill).toHaveBeenNthCalledWith(2, 'SIGKILL')
    } finally {
      kill.mockRestore()
      originalKill('SIGKILL')
      await closed
    }
  })

  it('waits for in-flight client callbacks after the ACP stream closes', { timeout: 20_000 }, async () => {
    const { dir, fixtureFile } = await scenario({ permissionProbe: true })
    let releasePermission: (() => void) | undefined
    const permissionReleased = new Promise<void>((resolve) => { releasePermission = resolve })
    let markPermissionStarted: (() => void) | undefined
    const permissionStarted = new Promise<void>((resolve) => { markPermissionStarted = resolve })
    let permissionFinished = false
    const launched = launchAcpTestAgent({
      agent: AGENT,
      cwd: dir,
      env: { DSH_SNAPSHOT_FILE: fixtureFile },
      async requestPermission() {
        markPermissionStarted?.()
        await permissionReleased
        permissionFinished = true
        return { outcome: { outcome: 'cancelled' } }
      },
    })
    await launched.client.initialize({ protocolVersion: PROTOCOL_VERSION, clientCapabilities: {} })
    const { sessionId } = await launched.client.newSession({ cwd: dir, mcpServers: [] })
    void launched.client.prompt({ sessionId, prompt: [{ type: 'text', text: 'go' }] }).catch(() => undefined)
    await permissionStarted

    const childClosed = once(launched.child, 'close')
    let closeSettled = false
    const closing = launched.close('SIGKILL').then(() => { closeSettled = true })
    await childClosed
    await launched.client.closed
    expect(closeSettled).toBe(false)

    releasePermission?.()
    await closing
    expect(permissionFinished).toBe(true)
  })

  it('includes agent stderr when the ACP connection closes during startup', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ failOnBoot: true, stderrNote: 'fake agent requested startup failure' })
    await expect(runScenario(
      { steps: [{ op: 'initialize' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(/agent stderr:\nfake agent requested startup failure/)
  })

  it('preserves launch-resolution errors when no child process exists', async () => {
    const { dir, fixtureFile } = await scenario({})
    vi.stubEnv('DSH_EXAMPLE_MODE', 'lib')
    try {
      await expect(runScenario(
        { steps: [] },
        {
          agent: { ...AGENT, binScript: join(dir, 'outside-src.ts'), libBinScript: undefined },
          mode: 'replay',
          fixtureFile,
        },
      )).rejects.toThrow(/expected a "\/src\/" segment/)
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('drives a full turn: initialize, session, prompt, permission stub, harvest', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({
      permissionProbe: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 42, cwd: '{{CWD}}' },
          { type: 'turn/start', seq: 1, time: 9, data: { turn: 1 } },
        ],
      }],
    })
    const result = await runScenario(
      { steps: [{ op: 'initialize' }, { op: 'newSession' }, { op: 'prompt', text: 'go' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionId).toBeDefined()
    // The harness's client answers a permission request with `cancelled`; the
    // fake bin echoes the outcome it received back as a chunk.
    expect(result.rawStdout).toContain('permission:{\\"outcome\\":\\"cancelled\\"}')
    expect(result.sessionLogs).toHaveLength(1)
    expect(result.sessionLogs[0]?.id).toBe(result.sessionId)
    expect(result.sessionLogs[0]?.createdAt).toBe(42)
    expect(result.sessionLogs[0]?.content).toContain('turn/start')
    // The harvested log embeds the run's REAL temp cwd (template-substituted).
    // The cwd is JSON-encoded in the log line, so compare the parsed field
    // rather than substring-matching a raw path (which breaks when the path
    // separator is escaped inside JSON text on Windows).
    const sessionLine = result.sessionLogs[0]?.content.split('\n').find(l => l.includes('"type":"session"')) ?? '{}'
    expect((JSON.parse(sessionLine) as { cwd?: string }).cwd).toBe(result.cwd)
  })

  it('drives a structured prompt-content step without flattening its wire blocks', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({})
    const result = await runScenario(
      {
        steps: [...boot, {
          op: 'promptContent',
          content: [
            { type: 'text', text: 'before' },
            { type: 'image', data: 'AQ==', mimeType: 'image/png' },
            { type: 'text', text: 'after' },
          ],
        }],
      },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.rawStdout).toContain('"stopReason":"end_turn"')
  })

  it('forwards override/child fixture paths into the child env and captures stderr', { timeout: 20_000 }, async () => {
    const { dir, fixtureFile } = await scenario({ echoEnv: true, stderrNote: 'fake bin booted' })
    const childFiles = [join(dir, 'session.1.jsonl'), join(dir, 'session.2.jsonl')]
    const result = await runScenario(
      { steps: [...boot, { op: 'prompt', text: 'env?' }] },
      {
        agent: AGENT,
        mode: 'replay',
        fixtureFile,
        overrideFile: join(dir, 'replay.override.json'),
        childFiles,
        // A workspaceDir that does not exist is skipped, not an error.
        workspaceDir: join(dir, 'no-such-workspace'),
      },
    )
    expect(result.stderr).toContain('fake bin booted')
    expect(result.rawStdout).toContain('replay.override.json')
    // Child paths ride one env var, joined with the platform delimiter.
    // Parse the fake bin's env-probe chunk rather than substring-matching a
    // JSON-encoded path (the escaping breaks raw-substring compares on Windows).
    const envChunk = result.rawStdout.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => JSON.parse(l) as { params?: { update?: { content?: { text?: string } } } })
      .find(f => f.params?.update?.content?.text?.startsWith('env:'))
    const env = JSON.parse((envChunk?.params?.update?.content?.text ?? 'env:{}').slice('env:'.length)) as {
      childFiles: string | null
    }
    expect(env.childFiles).toBe(childFiles.join(delimiter))
  })

  it('gives concurrent scenarios distinct equal-length spill roots', { timeout: 20_000 }, async () => {
    const [first, second] = await Promise.all([scenario({ echoEnv: true }), scenario({ echoEnv: true })])
    const results = await Promise.all([first, second].map(({ fixtureFile }) => runScenario(
      { steps: [...boot, { op: 'prompt', text: 'env?' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )))
    const roots = results.map(result => environmentEcho(result.rawStdout).spillRoot)
    expect(roots.every(root => typeof root === 'string')).toBe(true)
    expect(new Set(roots).size).toBe(2)
    expect((roots[0] as string).length).toBe((roots[1] as string).length)
    expect(roots).toEqual([
      snapshotSpillRoot(first.fixtureFile),
      snapshotSpillRoot(second.fixtureFile),
    ])
  })

  it('seeds the workspace dir into the temp cwd before the run', { timeout: 20_000 }, async () => {
    const { dir, fixtureFile } = await scenario({ echoWorkspace: true })
    const workspaceDir = join(dir, 'workspace')
    await writeFile(join(dir, 'behavior.json'), JSON.stringify({ echoWorkspace: true }))
    const { mkdir } = await import('node:fs/promises')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'seeded.txt'), 'hello')
    const result = await runScenario(
      { steps: [...boot, { op: 'prompt', text: 'ls' }] },
      { agent: AGENT, mode: 'replay', fixtureFile, workspaceDir },
    )
    expect(result.rawStdout).toContain('workspace:seeded.txt')
  })

  it('prepares the generated workspace after copying committed fixtures', { timeout: 20_000 }, async () => {
    const { dir, fixtureFile } = await scenario({ echoWorkspace: true })
    const workspaceDir = join(dir, 'workspace')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'committed.txt'), 'committed')

    const result = await runScenario(
      { steps: [...boot, { op: 'prompt', text: 'ls' }] },
      {
        agent: AGENT,
        mode: 'replay',
        fixtureFile,
        workspaceDir,
        prepareWorkspace: async (cwd) => {
          expect(await readFile(join(cwd, 'committed.txt'), 'utf8')).toBe('committed')
          await writeFile(join(cwd, 'runtime.txt'), 'runtime')
        },
      },
    )

    expect(result.rawStdout).toContain('workspace:committed.txt,runtime.txt')
  })

  it('creates the generated workspace under an explicit parent', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({})
    const workspaceParent = await mkdtemp(join(tmpdir(), 'acp-snap-parent-'))
    tempDirs.push(workspaceParent)

    const result = await runScenario(
      { steps: boot },
      { agent: AGENT, mode: 'replay', fixtureFile, workspaceParent },
    )

    const child = relative(workspaceParent, result.cwd)
    expect(child).not.toBe('')
    expect(child).not.toBe('..')
    expect(child.startsWith(`..${sep}`)).toBe(false)
  })

  it('promptAndCancel waits for the durable turn start, cancels, and settles the prompt', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ prompt: 'hang-until-cancel' })
    const result = await runScenario(
      { steps: [...boot, { op: 'promptAndCancel', text: 'hang' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.rawStdout).toContain('"stopReason":"cancelled"')
    // The streamed chunk deterministically precedes the cancelled response.
    expect(result.rawStdout.indexOf('thinking about it')).toBeLessThan(result.rawStdout.indexOf('cancelled'))
  })

  it('promptAndCancel can wait for cwd-relative readiness before cancelling', { timeout: 20_000 }, async () => {
    const { dir, fixtureFile } = await scenario({ prompt: 'hang-until-cancel' })
    const workspaceDir = join(dir, 'workspace')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'started.txt'), 'started')
    const result = await runScenario(
      {
        steps: [...boot, {
          op: 'promptAndCancel',
          text: 'hang',
          waitForFile: { path: 'started.txt' },
        }],
      },
      { agent: AGENT, mode: 'replay', fixtureFile, workspaceDir },
    )
    expect(result.rawStdout).toContain('"stopReason":"cancelled"')

    const missing = await scenario({ prompt: 'hang-until-cancel' })
    await expect(runScenario(
      {
        steps: [...boot, {
          op: 'promptAndCancel',
          text: 'hang',
          waitForFile: { path: 'never.txt', timeoutMs: 20 },
        }],
      },
      { agent: AGENT, mode: 'replay', fixtureFile: missing.fixtureFile },
    )).rejects.toThrow(/workspace file "never\.txt" did not appear within 20ms/)
  })

  it('promptAndWaitForAgentMessage keeps the app live through a matching later update', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ prompt: 'respond' })
    const result = await runScenario(
      {
        steps: [...boot, {
          op: 'promptAndWaitForAgentMessage',
          text: 'go',
          waitForText: 'thinking about it',
        }],
      },
      { agent: AGENT, mode: 'replay', fixtureFile, configPath: AGENT.configPath },
    )
    expect(result.rawStdout).toContain('thinking about it')
  })

  it('waitForTurnEnd holds cancellation open through the persisted closing boundary', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
          { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'aborted' } } },
        ],
      }],
    })
    const result = await runScenario(
      { steps: [...boot, { op: 'promptAndCancel', text: 'hang' }, { op: 'waitForTurnEnd' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionLogs[0]?.content).toContain('"type":"turn/end"')
  })

  it('waitForInboxMessage holds the app through a matching durable insertion', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
          {
            type: 'agent/inbox/spliced',
            seq: 0,
            time: 2,
            data: {
              target: 'next-turn',
              start: 0,
              inserted: [{ role: 'user', content: [{ type: 'text', text: 'durable marker' }] }],
            },
          },
        ],
      }],
    })
    const result = await runScenario(
      { steps: [...boot, { op: 'promptAndCancel', text: 'hang' }, { op: 'waitForInboxMessage', text: 'marker' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionLogs[0]?.content).toContain('durable marker')
  })

  it('waitForInboxMessage times out when the session log or matching insertion is absent', { timeout: 20_000 }, async () => {
    const absent = await scenario({ prompt: 'hang-until-cancel', persistLogsOnCancel: true })
    await expect(runScenario(
      { steps: [...boot, { op: 'promptAndCancel', text: 'hang' }, { op: 'waitForInboxMessage', text: 'missing', timeoutMs: 20 }] },
      { agent: AGENT, mode: 'replay', fixtureFile: absent.fixtureFile },
    )).rejects.toThrow(/did not persist expected inbox message within 20ms/)

    const unmatched = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [{ type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 }],
      }],
    })
    await expect(runScenario(
      { steps: [...boot, { op: 'promptAndCancel', text: 'hang' }, { op: 'waitForInboxMessage', text: 'missing', timeoutMs: 20 }] },
      { agent: AGENT, mode: 'replay', fixtureFile: unmatched.fixtureFile },
    )).rejects.toThrow(/did not persist expected inbox message within 20ms/)
  })

  it('waitForTitleAfterTurnEnd holds the app through a standalone durable title', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
          { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'aborted' } } },
          { type: 'session/title', seq: 2, time: 3, data: { title: 'Late title' } },
        ],
      }],
    })
    const result = await runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForTitleAfterTurnEnd' },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionLogs[0]?.content).toMatch(/"turn\/end"[\s\S]*"session\/title"/)
  })

  it('waitForTurnStart can require a later durable turn before continuing', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 3 } },
        ],
      }],
    })
    const result = await runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForTurnStart', minimumTurn: 3 },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionLogs[0]?.content).toContain('"turn":3')
  })

  it('waitForTurnStart rejects missing, earlier, and malformed durable turns', { timeout: 20_000 }, async () => {
    const missing = await scenario({})
    await expect(runScenario(
      { steps: [...boot, { op: 'waitForTurnStart', timeoutMs: 200 }] },
      { agent: AGENT, mode: 'replay', fixtureFile: missing.fixtureFile },
    )).rejects.toThrow(/did not persist turn\/start within 200ms/)

    const earlier = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        ],
      }],
    })
    await expect(runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForTurnStart', minimumTurn: 3, timeoutMs: 200 },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile: earlier.fixtureFile },
    )).rejects.toThrow(/turn\/start at or beyond turn 3 within 200ms/)

    const closed = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
          { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'stop' } } },
        ],
      }],
    })
    await expect(runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForTurnStart', timeoutMs: 200 },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile: closed.fixtureFile },
    )).rejects.toThrow(/did not persist turn\/start within 200ms/)

    for (const turn of [undefined, 0]) {
      const malformed = await scenario({
        prompt: 'hang-until-cancel',
        persistLogsOnCancel: true,
        logs: [{
          file: 'project/main/session.jsonl',
          lines: [
            { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
            { type: 'turn/start', seq: 0, time: 1, data: turn === undefined ? {} : { turn } },
          ],
        }],
      })
      await expect(runScenario(
        {
          steps: [
            ...boot,
            { op: 'promptAndCancel', text: 'hang' },
            { op: 'waitForTurnStart' },
          ],
        },
        { agent: AGENT, mode: 'replay', fixtureFile: malformed.fixtureFile },
      )).rejects.toThrow('invalid persisted turn/start record')
    }
  })

  it('waitForTurnEnd times out for a missing log and an open logged turn', { timeout: 20_000 }, async () => {
    const missing = await scenario({})
    await expect(runScenario(
      { steps: [...boot, { op: 'waitForTurnEnd', timeoutMs: 200 }] },
      { agent: AGENT, mode: 'replay', fixtureFile: missing.fixtureFile },
    )).rejects.toThrow(/did not persist turn\/end within 200ms/)

    const open = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
          { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        ],
      }],
    })
    await expect(runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForTurnEnd', timeoutMs: 200 },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile: open.fixtureFile },
    )).rejects.toThrow(/did not persist turn\/end within 200ms/)
  })

  it('waitForGoalPhase requires the requested durable goal phase', { timeout: 20_000 }, async () => {
    const reached = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
          { type: 'goal/change', seq: 1, time: 2, data: {} },
          { type: 'goal/change', seq: 2, time: 3, data: { goal: { phase: 'active' } } },
        ],
      }],
    })
    const result = await runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForGoalPhase', phase: 'active' },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile: reached.fixtureFile },
    )
    expect(result.sessionLogs[0]?.content).toContain('"phase":"active"')

    const missing = await scenario({})
    await expect(runScenario(
      { steps: [...boot, { op: 'waitForGoalPhase', phase: 'blocked', timeoutMs: 20 }] },
      { agent: AGENT, mode: 'replay', fixtureFile: missing.fixtureFile },
    )).rejects.toThrow(/did not persist goal phase "blocked" within 20ms/)
  })

  it('waitForSubagentTurnEnd requires a closed child work turn', { timeout: 20_000 }, async () => {
    const closed = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [
        {
          file: 'project/main/session.jsonl',
          lines: [
            { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
            { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'aborted' } } },
          ],
        },
        {
          file: 'project/child/session.jsonl',
          lines: [
            { type: 'session', version: 0, id: 'child-1', createdAt: 2, parentSession: '{{SID}}', delegationDepth: 1 },
            { type: 'subagent/descriptor', seq: 0, time: 1, data: {} },
            { type: 'turn/start', seq: 1, time: 2, data: { turn: 1 } },
            { type: 'request/header', seq: 2, time: 3, data: { header: {}, reason: 'initial' } },
            { type: 'turn/end', seq: 3, time: 4, data: { turn: 1, reason: { kind: 'completed' } } },
          ],
        },
      ],
    })
    const result = await runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForSubagentTurnEnd' },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile: closed.fixtureFile },
    )
    expect(result.sessionLogs[1]?.parentSession).toBe(result.sessionId)
    await expect(runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForSubagentTurnEnd', minimumTurn: 2, timeoutMs: 20 },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile: closed.fixtureFile },
    )).rejects.toThrow(/subagent child #1 did not persist closed turn 2 within 20ms/)

    const seedOnly = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [
        {
          file: 'project/main/session.jsonl',
          lines: [
            { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
            { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'aborted' } } },
          ],
        },
        {
          file: 'project/child/session.jsonl',
          lines: [
            { type: 'session', version: 0, id: 'child-1', createdAt: 2, parentSession: '{{SID}}', delegationDepth: 1 },
            { type: 'turn/start', seq: 0, time: 1, data: { turn: 1, trigger: { kind: 'message' } } },
            { type: 'request/header', seq: 1, time: 2, data: { header: {}, reason: 'initial' } },
            { type: 'turn/end', seq: 2, time: 3, data: { turn: 1, reason: { kind: 'completed' } } },
            { type: 'subagent/descriptor', seq: 3, time: 4, data: {} },
          ],
        },
      ],
    })
    await expect(runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForSubagentTurnEnd', timeoutMs: 20 },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile: seedOnly.fixtureFile },
    )).rejects.toThrow(/subagent child #1 did not persist closed turn 1 within 20ms/)

    const missing = await scenario({})
    await expect(runScenario(
      { steps: [...boot, { op: 'waitForSubagentTurnEnd', child: 2, timeoutMs: 20 }] },
      { agent: AGENT, mode: 'replay', fixtureFile: missing.fixtureFile },
    )).rejects.toThrow(/subagent child #2 did not persist closed turn 1 within 20ms/)
  })

  it('waitForTitleAfterTurnEnd times out when the title precedes the boundary', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
          { type: 'session/title', seq: 1, time: 1, data: { title: 'Early title' } },
          { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'aborted' } } },
        ],
      }],
    })
    await expect(runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForTitleAfterTurnEnd', timeoutMs: titleDiagnosticTimeoutMs },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(new RegExp(`did not persist session/title after turn/end within ${titleDiagnosticTimeoutMs}ms`))
  })

  it('waitForEventAfterTurnEnd holds the app for a typed post-boundary record and times out otherwise', { timeout: 20_000 }, async () => {
    const late = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
          { type: 'turn/end', seq: 1, time: 2, data: { turn: 1, reason: { kind: 'aborted' } } },
          { type: 'user/message', seq: 2, time: 3, data: { content: [{ type: 'text', text: 'late goal state' }], source: { kind: 'user' } } },
        ],
      }],
    })
    const result = await runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForEventAfterTurnEnd', type: 'user/message' },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile: late.fixtureFile },
    )
    expect(result.sessionLogs[0]?.content).toMatch(/"turn\/end"[\s\S]*"user\/message"/)

    const early = await scenario({
      prompt: 'hang-until-cancel',
      persistLogsOnCancel: true,
      logs: [{
        file: 'project/main/session.jsonl',
        lines: [
          { type: 'session', version: 0, id: '{{SID}}', createdAt: 1, delegationDepth: 0 },
          { type: 'user/message', seq: 1, time: 1, data: { content: [{ type: 'text', text: 'early' }], source: { kind: 'user' } } },
          { type: 'turn/end', seq: 2, time: 2, data: { turn: 1, reason: { kind: 'aborted' } } },
        ],
      }],
    })
    await expect(runScenario(
      {
        steps: [
          ...boot,
          { op: 'promptAndCancel', text: 'hang' },
          { op: 'waitForEventAfterTurnEnd', type: 'user/message', timeoutMs: 20 },
        ],
      },
      { agent: AGENT, mode: 'replay', fixtureFile: early.fixtureFile },
    )).rejects.toThrow(/did not persist user\/message after turn\/end within 20ms/)
  })

  it('promptExpectError swallows a model-error response as the expected outcome', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ prompt: 'error' })
    const result = await runScenario(
      { steps: [...boot, { op: 'promptExpectError', text: 'boom' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.rawStdout).toContain('model exploded')
  })

  it('promptExpectError throws when the prompt unexpectedly succeeds (and teardown kills the live child)', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ prompt: 'respond' })
    await expect(runScenario(
      { steps: [...boot, { op: 'promptExpectError', text: 'fine' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(/expected the prompt to fail/)
  })

  it('reports scenario and cleanup failures together', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ prompt: 'respond' })
    const cleanupFailure = new Error('cleanup failed')
    fsControl.cleanupFailure = cleanupFailure

    const failure = await runScenario(
      { steps: [...boot, { op: 'promptExpectError', text: 'fine' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    ).catch((error: unknown): unknown => error)

    expect(failure).toBeInstanceOf(AggregateError)
    const failures = (failure as AggregateError).errors as unknown[]
    expect(failures).toHaveLength(2)
    expect(failures[0]).toBeInstanceOf(Error)
    expect((failures[0] as Error).message).toMatch(/expected the prompt to fail/)
    expect(failures[1]).toBe(cleanupFailure)
  })

  it('reports cleanup failure after an otherwise successful scenario', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({})
    const cleanupFailure = new Error('cleanup failed')
    fsControl.cleanupFailure = cleanupFailure

    const failure = await runScenario(
      { steps: boot },
      { agent: AGENT, mode: 'replay', fixtureFile },
    ).catch((error: unknown): unknown => error)

    expect(failure).toBeInstanceOf(AggregateError)
    expect((failure as AggregateError).message).toBe('snapshot cleanup failed')
    expect((failure as AggregateError).errors as unknown[]).toEqual([cleanupFailure])
  })

  it('newSessionExpectError swallows the rejection, with and without extra dirs', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ rejectExtraDirs: true })
    const result = await runScenario(
      { steps: [{ op: 'initialize' }, { op: 'newSessionExpectError', additionalDirectories: ['/elsewhere'] }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    // No session was created, so no id and no logs.
    expect(result.sessionId).toBeUndefined()
    expect(result.sessionLogs).toHaveLength(0)

    const rejectAll = await scenario({ rejectNewSession: true })
    const second = await runScenario(
      { steps: [{ op: 'initialize' }, { op: 'newSessionExpectError' }] },
      { agent: AGENT, mode: 'replay', fixtureFile: rejectAll.fixtureFile },
    )
    expect(second.rawStdout).toContain('unsupported workspace scope')
  })

  it('newSessionExpectError throws when session/new unexpectedly succeeds', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({})
    await expect(runScenario(
      { steps: [{ op: 'initialize' }, { op: 'newSessionExpectError' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(/expected session\/new to be rejected/)
  })

  it('a plain cancel step is forwarded (and ignored by an idle agent)', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({})
    const result = await runScenario(
      { steps: [...boot, { op: 'cancel' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionId).toBeDefined()
  })

  it('a standalone cancel can wait for cwd-relative readiness', { timeout: 20_000 }, async () => {
    const { dir, fixtureFile } = await scenario({})
    const workspaceDir = join(dir, 'workspace')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'ready'), '')
    const result = await runScenario(
      { steps: [...boot, { op: 'cancel', waitForFile: { path: 'ready' } }] },
      { agent: AGENT, mode: 'replay', fixtureFile, workspaceDir },
    )
    expect(result.sessionId).toBeDefined()
  })

  it('waitForFile holds the next input step behind cwd-relative readiness', { timeout: 20_000 }, async () => {
    const { dir, fixtureFile } = await scenario({})
    const workspaceDir = join(dir, 'workspace')
    const { mkdir } = await import('node:fs/promises')
    await mkdir(workspaceDir, { recursive: true })
    await writeFile(join(workspaceDir, 'ready'), '')
    const result = await runScenario(
      { steps: [...boot, { op: 'waitForFile', path: 'ready' }, { op: 'cancel' }] },
      { agent: AGENT, mode: 'replay', fixtureFile, workspaceDir },
    )
    expect(result.sessionId).toBeDefined()
  })

  it.each([
    [{ op: 'prompt', text: 'x' }, /prompt before newSession/],
    [{ op: 'promptContent', content: [{ type: 'text', text: 'x' }] }, /promptContent before newSession/],
    [{ op: 'promptAndWaitForAgentMessage', text: 'x', waitForText: 'later' }, /promptAndWaitForAgentMessage before newSession/],
    [{ op: 'promptExpectError', text: 'x' }, /promptExpectError before newSession/],
    [{ op: 'promptAndCancel', text: 'x' }, /promptAndCancel before newSession/],
    [{ op: 'waitForTurnStart' }, /waitForTurnStart before newSession/],
    [{ op: 'waitForTurnEnd' }, /waitForTurnEnd before newSession/],
    [{ op: 'waitForGoalPhase', phase: 'active' }, /waitForGoalPhase before newSession/],
    [{ op: 'waitForInboxMessage', text: 'marker' }, /waitForInboxMessage before newSession/],
    [{ op: 'waitForTitleAfterTurnEnd' }, /waitForTitleAfterTurnEnd before newSession/],
    [{ op: 'waitForEventAfterTurnEnd', type: 'user/message' }, /waitForEventAfterTurnEnd before newSession/],
    [{ op: 'cancel' }, /cancel before newSession/],
  ] as [InputStep, RegExp][])('rejects %j before newSession', { timeout: 20_000 }, async (step, message) => {
    const { fixtureFile } = await scenario({})
    await expect(runScenario(
      { steps: [{ op: 'initialize' }, step] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(message)
  })

  it('rejects an unknown input op', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({})
    const bogus = { op: 'reticulate' } as unknown as InputStep
    await expect(runScenario(
      { steps: [bogus] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(/unknown input op/)
  })

  it('harvests all logs primary-first, children by createdAt then id, skipping filesystem noise', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({
      strayRootFile: true,
      strayBucketFile: true,
      logs: [
        // File names chosen so readdir feeds the sort children-first AND
        // parent-in-the-middle: the comparator then sees a parent on both
        // sides of a pair, plus the same-createdAt (localeCompare) tiebreak.
        { file: 'b1/aa-child-c/session.jsonl', lines: [{ type: 'session', version: 0, id: 'cccccccc-0000-4000-8000-000000000000', createdAt: 500, parentSession: '{{SID}}' }] },
        { file: 'b1/bb-parent/session.jsonl', lines: [{ type: 'session', version: 0, id: 'superseded-parent', createdAt: 1 }] },
        { file: 'b1/bb-parent/session.v1.jsonl', lines: [{ type: 'session', version: 1, id: '{{SID}}', createdAt: 900 }] },
        { file: 'b1/cc-child-a/session.jsonl', lines: [{ type: 'session', version: 0, id: 'aaaaaaaa-0000-4000-8000-000000000000', createdAt: 500, parentSession: '{{SID}}' }] },
        // Missing id/createdAt fall back to ''/0; earliest child by createdAt.
        { file: 'b2/orphan/session.jsonl', lines: [{ type: 'session', version: 0, parentSession: '{{SID}}' }] },
      ],
    })
    const result = await runScenario(
      { steps: [...boot, { op: 'prompt', text: 'go' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionLogs.map(l => [l.id, l.createdAt])).toEqual([
      [result.sessionId, 900],
      ['', 0],
      ['aaaaaaaa-0000-4000-8000-000000000000', 500],
      ['cccccccc-0000-4000-8000-000000000000', 500],
    ])
    expect(result.sessionLogs[1]?.parentSession).toBe(result.sessionId)
  })

  it('rejects an empty persisted generation', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ logs: [{ file: 'b/empty/session.jsonl', lines: [] }] })
    await expect(runScenario(
      { steps: boot },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow('session.jsonl: session fixture is empty')
  })

  it('rejects a persisted filename/header generation mismatch', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({
      logs: [{ file: 'b/mismatch/session.v1.jsonl', lines: [{ type: 'session', version: 0 }] }],
    })
    await expect(runScenario(
      { steps: boot },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow('filename declares Session format v1, header declares v0')
  })

  it('yields no logs when the sessions root vanished', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ deleteSessionsRoot: true })
    const result = await runScenario(
      { steps: boot },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.sessionLogs).toHaveLength(0)
  })

  it('answers permission requests from the scripted queue by option kind, falling back to cancelled', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ permissionProbe: true })
    // Two prompts → two permission round-trips; one scripted answer, so the
    // second request exercises the exhausted-queue fallback.
    const result = await runScenario(
      {
        steps: [...boot, { op: 'prompt', text: 'one' }, { op: 'prompt', text: 'two' }],
        permissionAnswers: [{ kind: 'allow_once' }],
      },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    const first = result.rawStdout.indexOf('permission:{\\"outcome\\":\\"selected\\",\\"optionId\\":\\"opt-allow\\"}')
    const second = result.rawStdout.indexOf('permission:{\\"outcome\\":\\"cancelled\\"}')
    expect(first).toBeGreaterThanOrEqual(0)
    expect(second).toBeGreaterThan(first)
  })

  it('selects a non-first offered option by kind', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ permissionProbe: true })
    const result = await runScenario(
      { steps: [...boot, { op: 'prompt', text: 'deny it' }], permissionAnswers: [{ kind: 'reject_once' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )
    expect(result.rawStdout).toContain('permission:{\\"outcome\\":\\"selected\\",\\"optionId\\":\\"opt-reject\\"}')
  })

  it('rejects the run on a scripted permission kind the agent never offered', { timeout: 20_000 }, async () => {
    const { fixtureFile } = await scenario({ permissionProbe: true })
    // The fake bin offers allow_once/reject_once; scripting allow_always is a
    // scenario bug. The agent is answered `cancelled` (it must not be able to
    // absorb the bug as an error-means-denial), and the RUN fails: a callback
    // throw would only reach the agent as a JSON-RPC error response, letting
    // a tolerant agent carry on and the scenario pass — or record.
    await expect(runScenario(
      { steps: [...boot, { op: 'prompt', text: 'impossible click' }], permissionAnswers: [{ kind: 'allow_always' }] },
      { agent: AGENT, mode: 'replay', fixtureFile },
    )).rejects.toThrow(/allow_always not among the offered options \[allow_once, reject_once\]/)
  })
})
