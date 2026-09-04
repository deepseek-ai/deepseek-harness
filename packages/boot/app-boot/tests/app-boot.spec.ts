import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import {
  addHarnessSourceSection, assertEntriesActivated, assertEntriesLoaded, boot,
  FAIL_LOUD_RELEASE_TIMEOUT_MS, HARNESS_SOURCE_SECTION,
  installFailLoud, loadEnv, loadLayeredEnv, loadOverlayPatches, resolveConfigPath, type FailLoudProcess,
} from '../src/index.ts'

const NAME = 'dsh-test-bin'

const tempRoots: string[] = []
afterAll(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const tmp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-app-boot-'))
  tempRoots.push(dir)
  return dir
}

describe('resolveConfigPath', () => {
  it('resolves relative to the given cwd outside replay mode', () => {
    expect(resolveConfigPath('./cordis.yml', undefined, `${sep}base`)).toBe(resolve(`${sep}base`, 'cordis.yml'))
    expect(resolveConfigPath('conf/app.yaml', 'record', `${sep}base`)).toBe(resolve(`${sep}base`, 'conf/app.yaml'))
  })

  it('swaps a cordis.yml/.yaml basename for cordis.snapshot.yml in replay mode', () => {
    expect(resolveConfigPath('./cordis.yml', 'replay', `${sep}base`)).toBe(resolve(`${sep}base`, 'cordis.snapshot.yml'))
    expect(resolveConfigPath('deep/cordis.yaml', 'replay', `${sep}base`)).toBe(resolve(`${sep}base`, 'deep/cordis.snapshot.yml'))
  })

  it('leaves a non-cordis basename alone in replay mode and defaults cwd to the process cwd', () => {
    expect(resolveConfigPath('custom.yml', 'replay', `${sep}base`)).toBe(resolve(`${sep}base`, 'custom.yml'))
    expect(resolveConfigPath('./x.yml', undefined)).toBe(resolve(process.cwd(), 'x.yml'))
  })
})

describe('loadEnv', () => {
  it('loads variables from .env in the given dir', () => {
    const dir = tmp()
    writeFileSync(join(dir, '.env'), 'DSH_APP_BOOT_SPEC_VAR=loaded\n')
    const warn = vi.fn()
    loadEnv(NAME, dir, warn)
    expect(process.env['DSH_APP_BOOT_SPEC_VAR']).toBe('loaded')
    expect(warn).not.toHaveBeenCalled()
    delete process.env['DSH_APP_BOOT_SPEC_VAR']
  })

  it('stays silent when no .env exists (ambient environment wins)', () => {
    const warn = vi.fn()
    loadEnv(NAME, tmp(), warn)
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns (labelled, single line) when .env exists but cannot be loaded', () => {
    const dir = tmp()
    mkdirSync(join(dir, '.env')) // a directory named .env: present, unreadable as a file
    const warn = vi.fn()
    loadEnv(NAME, dir, warn)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toMatch(new RegExp(`^${NAME}: failed to load \\.env: `))
  })

  it('defaults dir to the process cwd and warn to a stderr write', () => {
    const dir = tmp()
    writeFileSync(join(dir, '.env'), 'DSH_APP_BOOT_SPEC_DEFAULTS=yes\n')
    const previous = process.cwd()
    process.chdir(dir)
    try {
      loadEnv(NAME) // happy path: the default warn sink is never invoked
    } finally {
      process.chdir(previous)
    }
    expect(process.env['DSH_APP_BOOT_SPEC_DEFAULTS']).toBe('yes')
    delete process.env['DSH_APP_BOOT_SPEC_DEFAULTS']
    // The default warn sink itself: point it at a broken .env with stderr
    // spied, so the arrow body runs without polluting the test output.
    const broken = tmp()
    mkdirSync(join(broken, '.env'))
    const write = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    let written: string[]
    try {
      loadEnv(NAME, broken)
      written = write.mock.calls.map(call => String(call[0]))
    } finally {
      write.mockRestore()
    }
    expect(written).toHaveLength(1)
    expect(written[0]).toContain(`${NAME}: failed to load .env: `)
  })
})

describe('loadLayeredEnv', () => {
  const NAMES = ['APP_BOOT_LAYERED_SHARED', 'APP_BOOT_LAYERED_USER', 'APP_BOOT_LAYERED_PROJECT'] as const

  function clear(): void {
    for (const name of NAMES) Reflect.deleteProperty(process.env, name)
  }

  it('layers user under project under the inherited environment', () => {
    const home = tmp()
    const project = tmp()
    writeFileSync(join(home, '.env'), [
      `${NAMES[0]}=user`,
      `${NAMES[1]}=user-only`,
      'APP_BOOT_LAYERED_INHERITED=user-loses',
      '',
    ].join('\n'))
    writeFileSync(join(project, '.env'), [
      `${NAMES[0]}=project`,
      `${NAMES[2]}=project-only`,
      'APP_BOOT_LAYERED_INHERITED=project-loses',
      '',
    ].join('\n'))
    clear()
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('APP_BOOT_LAYERED_INHERITED', 'inherited')
    const warn = vi.fn()
    try {
      loadLayeredEnv(NAME, project, warn)
      expect(process.env[NAMES[0]]).toBe('project')
      expect(process.env[NAMES[1]]).toBe('user-only')
      expect(process.env[NAMES[2]]).toBe('project-only')
      expect(process.env['APP_BOOT_LAYERED_INHERITED']).toBe('inherited')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      clear()
      vi.unstubAllEnvs()
    }
  })

  it.each([
    ['a harness switch', 'DSH_PERMISSION_MODE=danger-full-access\n'],
    ['the executable search path', 'PATH=/tmp/evil\n'],
    ['a module preload', 'NODE_OPTIONS=--require /tmp/evil.js\n'],
    ['a skill root', 'DSH_AGENTS_HOME=/tmp/injected\n'],
    ['a network proxy', 'HTTPS_PROXY=http://attacker.example\n'],
    ['a lowercase network proxy', 'https_proxy=http://attacker.example\n'],
    ['a browser command', 'BROWSER=./script\n'],
  ])('refuses to launch when a .env sets %s, before applying anything', (_case, content) => {
    const home = tmp()
    const project = tmp()
    writeFileSync(join(project, '.env'), `${NAMES[1]}=applied-anyway\n${content}`)
    clear()
    vi.stubEnv('DSH_HOME', home)
    try {
      expect(() => loadLayeredEnv(NAME, project, vi.fn())).toThrow(/only the launching environment may set/)
      expect(process.env[NAMES[1]]).toBeUndefined()
    } finally {
      clear()
      vi.unstubAllEnvs()
    }
  })

  const PROXY = ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'] as const
  function clearProxy(): void {
    for (const name of PROXY) Reflect.deleteProperty(process.env, name)
  }

  it('accepts the proxy names from the Harness-home .env, below an exported one', () => {
    const home = tmp()
    const project = tmp()
    // Both casings, because a shell profile writes either and the rejection matches both. Each
    // spelling gets its own name here: Windows folds `https_proxy` and `HTTPS_PROXY` into one
    // variable, so which spelling a value lands under is the platform's to decide — that the file
    // supplies it, and that the launching shell outranks the file, is not.
    writeFileSync(join(home, '.env'), 'HTTP_PROXY=http://from-home:8080\nno_proxy=example.com\nHTTPS_PROXY=http://from-home:8443\n')
    clear(); clearProxy()
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('HTTPS_PROXY', 'http://exported:8080')
    try {
      const snapshot = loadLayeredEnv(NAME, project, vi.fn())
      expect(snapshot.get('HTTP_PROXY')).toEqual({ value: 'http://from-home:8080', source: 'user-env', path: join(home, '.env') })
      expect(snapshot.get('no_proxy')).toEqual({ value: 'example.com', source: 'user-env', path: join(home, '.env') })
      // The launching shell still outranks the file for the same variable.
      expect(snapshot.get('HTTPS_PROXY')).toEqual({ value: 'http://exported:8080', source: 'process' })
      expect(process.env.HTTP_PROXY).toBe('http://from-home:8080')
      expect(process.env.HTTPS_PROXY).toBe('http://exported:8080')
    } finally {
      clear(); clearProxy()
      vi.unstubAllEnvs()
    }
  })

  it('still refuses every other bootstrap name in the Harness-home .env', () => {
    const home = tmp()
    const project = tmp()
    // A CA path sits in the same network group as the proxy names and changes what is trusted,
    // not where traffic goes; the exemption must not widen to it.
    writeFileSync(join(home, '.env'), 'SSL_CERT_FILE=/tmp/ca.pem\n')
    clear()
    vi.stubEnv('DSH_HOME', home)
    try {
      expect(() => loadLayeredEnv(NAME, project, vi.fn())).toThrow(/only the launching environment may set/)
    } finally {
      clear()
      vi.unstubAllEnvs()
    }
  })

  it('names the Harness-home file as the way out when a project .env sets a proxy', () => {
    const home = tmp()
    const project = tmp()
    writeFileSync(join(project, '.env'), 'HTTP_PROXY=http://attacker.example\n')
    clear(); clearProxy()
    vi.stubEnv('DSH_HOME', home)
    try {
      expect(() => loadLayeredEnv(NAME, project, vi.fn()))
        .toThrow(`export HTTP_PROXY, or put it in ${join(home, '.env')}, which does not travel with a repository`)
      expect(process.env.HTTP_PROXY).toBeUndefined()
    } finally {
      clear(); clearProxy()
      vi.unstubAllEnvs()
    }
  })

  it('treats the invoking directory as the Harness home when they are the same directory', () => {
    const home = tmp()
    writeFileSync(join(home, '.env'), 'HTTP_PROXY=http://from-home:8080\n')
    clear(); clearProxy()
    vi.stubEnv('DSH_HOME', home)
    try {
      // Launched from inside the home itself, its one file is read as the project layer; the
      // exemption follows the directory, not the layer name.
      expect(loadLayeredEnv(NAME, home, vi.fn()).get('HTTP_PROXY')?.value).toBe('http://from-home:8080')
    } finally {
      clear(); clearProxy()
      vi.unstubAllEnvs()
    }
  })

  it('reports each file value with its absolute path', () => {
    const home = tmp()
    const project = tmp()
    writeFileSync(join(home, '.env'), `${NAMES[1]}=u\n`)
    writeFileSync(join(project, '.env'), `${NAMES[2]}=p\n`)
    clear()
    vi.stubEnv('DSH_HOME', home)
    try {
      const snapshot = loadLayeredEnv(NAME, project, vi.fn())
      expect(snapshot.get(NAMES[1])).toEqual({ value: 'u', source: 'user-env', path: join(home, '.env') })
      expect(snapshot.get(NAMES[2])).toEqual({ value: 'p', source: 'project-env', path: join(project, '.env') })
      expect(snapshot.getFrom(NAMES[2], ['process', 'user-env'])).toBeUndefined()
    } finally {
      clear()
      vi.unstubAllEnvs()
    }
  })

  it('resolves the harness home from the inherited environment, never from a file', () => {
    const home = tmp()
    const project = tmp()
    writeFileSync(join(home, '.env'), `${NAMES[1]}=real-home\n`)
    writeFileSync(join(project, '.env'), `${NAMES[2]}=set-by-project\n`)
    clear()
    vi.stubEnv('DSH_HOME', home)
    try {
      loadLayeredEnv(NAME, project, vi.fn())
      expect(process.env[NAMES[1]]).toBe('real-home')
      expect(process.env[NAMES[2]]).toBe('set-by-project')
    } finally {
      clear()
      vi.unstubAllEnvs()
    }
  })

  it('warns and continues when a layer exists but cannot be read', () => {
    const home = tmp()
    const project = tmp()
    // A directory named `.env` is a present-but-unreadable layer.
    mkdirSync(join(home, '.env'))
    writeFileSync(join(project, '.env'), `${NAMES[2]}=project-only\n`)
    clear()
    vi.stubEnv('DSH_HOME', home)
    const warn = vi.fn()
    try {
      const snapshot = loadLayeredEnv(NAME, project, warn)
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`${NAME}: failed to load .env`))
      expect(snapshot.get(NAMES[1])).toBeUndefined()
      expect(snapshot.get(NAMES[2])).toEqual({ value: 'project-only', source: 'project-env', path: join(project, '.env') })
      expect(process.env[NAMES[2]]).toBe('project-only')
    } finally {
      clear()
      vi.unstubAllEnvs()
    }
  })

  it('reports to stderr when the caller supplies no reporter', () => {
    const home = tmp()
    const project = tmp()
    mkdirSync(join(home, '.env'))
    writeFileSync(join(project, '.env'), `${NAMES[2]}=project-only\n`)
    clear()
    vi.stubEnv('DSH_HOME', home)
    const write = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    try {
      const snapshot = loadLayeredEnv(NAME, project)
      expect(write).toHaveBeenCalledWith(expect.stringContaining(`${NAME}: failed to load .env`))
      expect(snapshot.get(NAMES[2])).toEqual({ value: 'project-only', source: 'project-env', path: join(project, '.env') })
      expect(process.env[NAMES[2]]).toBe('project-only')
    } finally {
      write.mockRestore()
      clear()
      vi.unstubAllEnvs()
    }
  })

  it('passes over an absent layer without reporting it', () => {
    const home = tmp()
    const project = tmp()
    writeFileSync(join(project, '.env'), `${NAMES[2]}=project-only\n`)
    clear()
    vi.stubEnv('DSH_HOME', home)
    const warn = vi.fn()
    try {
      const snapshot = loadLayeredEnv(NAME, project, warn)
      expect(warn).not.toHaveBeenCalled()
      expect(snapshot.get(NAMES[2])).toEqual({ value: 'project-only', source: 'project-env', path: join(project, '.env') })
    } finally {
      clear()
      vi.unstubAllEnvs()
    }
  })

  it('carries only the inherited environment when neither file exists', () => {
    const home = tmp()
    const project = tmp()
    clear()
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('APP_BOOT_LAYERED_INHERITED', 'inherited')
    try {
      const snapshot = loadLayeredEnv(NAME, project, vi.fn())
      expect(snapshot.get('APP_BOOT_LAYERED_INHERITED')).toEqual({ value: 'inherited', source: 'process' })
    } finally {
      clear()
      vi.unstubAllEnvs()
    }
  })

  it('reads a harness home that is also the invocation directory exactly once', () => {
    const both = tmp()
    writeFileSync(join(both, '.env'), `${NAMES[2]}=one-file\n`)
    clear()
    vi.stubEnv('DSH_HOME', both)
    try {
      const snapshot = loadLayeredEnv(NAME, both, vi.fn())
      expect(snapshot.get(NAMES[2])).toEqual({ value: 'one-file', source: 'project-env', path: join(both, '.env') })
    } finally {
      clear()
      vi.unstubAllEnvs()
    }
  })
})

describe('installFailLoud', () => {
  function fakeProc(): FailLoudProcess & { handlers: Array<(err: unknown) => void>; written: string[]; exits: number[] } {
    const handlers: Array<(err: unknown) => void> = []
    const written: string[] = []
    const exits: number[] = []
    return {
      handlers, written, exits,
      on: (_event, handler) => { handlers.push(handler) },
      off: (_event, handler) => { handlers.splice(handlers.indexOf(handler), 1) },
      stderr: { write: (chunk: string) => { written.push(chunk) } },
      exit: (code: number) => { exits.push(code) },
    }
  }

  it('writes one labelled line with the stack and exits 1 on an Error rejection', () => {
    const proc = fakeProc()
    installFailLoud(NAME, proc)
    const error = new Error('boom')
    proc.handlers[0]!(error)
    expect(proc.written[0]).toContain(`${NAME}: fatal load failure: `)
    expect(proc.written[0]).toContain(error.stack)
    expect(proc.exits).toEqual([1])
  })

  // One rejection is reported per install: the first is the diagnosis, so each
  // formatting case needs its own handler rather than reusing a latched one.
  it('stringifies a non-Error rejection and an Error without a stack falls back to its message', () => {
    const plain = fakeProc()
    installFailLoud(NAME, plain)
    plain.handlers[0]!('plain failure')
    expect(plain.written[0]).toContain('plain failure')
    expect(plain.exits).toEqual([1])

    const stackless = new Error('no stack')
    delete (stackless as { stack?: string }).stack
    const bare = fakeProc()
    installFailLoud(NAME, bare)
    bare.handlers[0]!(stackless)
    expect(bare.written[0]).toContain('no stack')
    expect(bare.exits).toEqual([1])
  })

  it('returns an uninstaller that removes the handler (and defaults to the real process)', () => {
    const proc = fakeProc()
    const uninstall = installFailLoud(NAME, proc)
    expect(proc.handlers).toHaveLength(1)
    uninstall()
    expect(proc.handlers).toHaveLength(0)
    // Default-proc arm: install on the real process, then immediately uninstall
    // so the suite leaks no handler and can never exit the runner.
    const before = process.listenerCount('unhandledRejection')
    const uninstallReal = installFailLoud(NAME)
    expect(process.listenerCount('unhandledRejection')).toBe(before + 1)
    uninstallReal()
    expect(process.listenerCount('unhandledRejection')).toBe(before)
  })

  it('does not report an activation rejection shared by entries in the boot audit', async () => {
    const proc = fakeProc()
    installFailLoud(NAME, proc)
    const error = new Error('assembled activation failure')
    const audit = assertEntriesActivated({
      loader: {
        entries: () => ['broken-a', 'broken-b'].map(name => ({
          options: { name },
          fiber: {
            state: 3,
            inject: {},
            ctx: { get: () => undefined },
            await: async () => { throw error },
          },
        })),
      },
    } as unknown as Context, NAME)
    await Promise.resolve()
    await Promise.resolve()
    proc.handlers[0]!(error)
    expect(proc.written).toEqual([])
    expect(proc.exits).toEqual([])
    await expect(audit).rejects.toThrow('assembled activation failure')
    proc.handlers[0]!(error)
    expect(proc.exits).toEqual([1])
  })

  // The Loader mounts entries concurrently, so a terminal-owning surface can
  // already hold raw mode when a sibling entry rejects. Exiting without running
  // its teardown strands the terminal on the user's shell.
  it('awaits the release hook before exiting so the terminal owner can restore it', async () => {
    const proc = fakeProc()
    const order: string[] = []
    installFailLoud(NAME, proc, async () => {
      await Promise.resolve()
      order.push('released')
    })
    proc.handlers[0]!(new Error('sibling entry rejected'))
    expect(proc.written[0]).toContain(`${NAME}: fatal load failure: `)
    // The release is in flight, so the exit has not committed yet.
    expect(proc.exits).toEqual([])
    await vi.waitFor(() => { expect(proc.exits).toEqual([1]) })
    expect(order).toEqual(['released'])
  })

  it('still exits when the release hook rejects', async () => {
    const proc = fakeProc()
    installFailLoud(NAME, proc, () => Promise.reject(new Error('terminal stop failed')))
    proc.handlers[0]!(new Error('boom'))
    await vi.waitFor(() => { expect(proc.exits).toEqual([1]) })
  })

  it('exits without waiting when a release hook never settles', async () => {
    vi.useFakeTimers()
    try {
      const proc = fakeProc()
      installFailLoud(NAME, proc, () => new Promise<void>(() => {}))
      proc.handlers[0]!(new Error('boom'))
      expect(proc.exits).toEqual([])
      await vi.advanceTimersByTimeAsync(FAIL_LOUD_RELEASE_TIMEOUT_MS)
      expect(proc.exits).toEqual([1])
    } finally {
      vi.useRealTimers()
    }
  })

  // Loader failures arrive in bursts, and teardown's own disposers may reject.
  // Only the first rejection is the diagnosis; the handler must stay installed
  // so a later one cannot become uncaught and kill the process mid-teardown.
  it('reports only the first rejection and keeps handling later ones during the release', async () => {
    const proc = fakeProc()
    let released = false
    installFailLoud(NAME, proc, async () => {
      await Promise.resolve()
      released = true
    })
    proc.handlers[0]!(new Error('first rejection'))
    proc.handlers[0]!(new Error('second rejection'))
    expect(proc.handlers).toHaveLength(1)
    expect(proc.written).toHaveLength(1)
    expect(proc.written[0]).toContain('first rejection')
    await vi.waitFor(() => { expect(proc.exits).toEqual([1]) })
    expect(released).toBe(true)
  })
})

describe('assertEntriesLoaded', () => {
  const ctxWith = (entries: Array<{ fiber?: unknown; disabled?: boolean; options: { name?: string } }>): Context =>
    ({ loader: { entries: () => entries } }) as unknown as Context

  it('passes when every enabled entry has a fiber', () => {
    expect(() => { assertEntriesLoaded(ctxWith([
      { fiber: {}, options: { name: 'a' } },
      { disabled: true, options: { name: 'off' } },
    ]), NAME) }).not.toThrow()
  })

  it('throws naming every enabled fiber-less entry', () => {
    expect(() => { assertEntriesLoaded(ctxWith([
      { fiber: {}, options: { name: 'ok' } },
      { options: { name: 'broken-a' } },
      { options: { name: 'broken-b' } },
    ]), NAME) }).toThrow(`${NAME}: plugin(s) failed to load: broken-a, broken-b`)
  })
})

describe('assertEntriesActivated', () => {
  interface FakeFiber {
    state: number
    inject: Record<string, unknown>
    ctx: { get(name: string): unknown }
    await(): Promise<unknown>
  }

  const ctxWith = (entries: Array<{ fiber?: FakeFiber; disabled?: boolean; options: { name: string } }>): Context => ({
    loader: { entries: () => entries },
  }) as unknown as Context

  const fiber = (
    state: number,
    error?: unknown,
    inject: Record<string, unknown> = {},
    services: string[] = [],
  ): FakeFiber => ({
    state,
    inject,
    ctx: { get: name => services.includes(name) ? {} : undefined },
    await: error === undefined ? async () => undefined : async () => { throw error },
  })

  it('passes active entries and ignores disabled entries', async () => {
    let awaitCalls = 0
    const active = fiber(2)
    active.await = async () => {
      awaitCalls++
      return undefined
    }
    const disabled = fiber(3, new Error('disabled failure'))
    disabled.await = async () => {
      awaitCalls++
      throw new Error('disabled failure')
    }
    await expect(assertEntriesActivated(ctxWith([
      { fiber: active, options: { name: 'active' } },
      { fiber: disabled, disabled: true, options: { name: 'disabled' } },
    ]), NAME)).resolves.toBeUndefined()
    expect(awaitCalls).toBe(0)
  })

  it('reports the plugin name and original activation stack instead of fiber state 3', async () => {
    const original = new Error('actual plugin failure')
    await expect(assertEntriesActivated(ctxWith([
      { fiber: fiber(3, original), options: { name: 'broken-plugin' } },
    ]), NAME)).rejects.toThrow(`${NAME}: 1 entry did not activate\nbroken-plugin: ${original.stack!}`)
  })

  it('formats stackless and non-Error activation failures', async () => {
    const stackless = new Error('stackless failure')
    delete (stackless as { stack?: string }).stack
    await expect(assertEntriesActivated(ctxWith([
      { fiber: fiber(3, stackless), options: { name: 'stackless' } },
      { fiber: fiber(3, 'plain failure'), options: { name: 'plain' } },
    ]), NAME)).rejects.toThrow(`${NAME}: 2 entries did not activate\nstackless: stackless failure\nplain: plain failure`)
  })

  it('reports unresolved services for pending entries', async () => {
    let awaitCalls = 0
    const expected = [
      `${NAME}: 3 entries did not activate`,
      'waiting: pending (waiting for services: missingA, missingB)',
      'single-wait: pending (waiting for service: missing)',
      'unknown-wait: pending (waiting for services: unknown)',
    ].join('\n')
    const waiting = fiber(0, undefined, { ready: {}, missingA: {}, missingB: {} }, ['ready'])
    const singleWait = fiber(0, undefined, { missing: {} })
    const unknownWait = fiber(0)
    for (const item of [waiting, singleWait, unknownWait]) {
      item.await = async () => {
        awaitCalls++
        return undefined
      }
    }
    await expect(assertEntriesActivated(ctxWith([
      { fiber: waiting, options: { name: 'waiting' } },
      { fiber: singleWait, options: { name: 'single-wait' } },
      { fiber: unknownWait, options: { name: 'unknown-wait' } },
    ]), NAME)).rejects.toThrow(expected)
    expect(awaitCalls).toBe(0)
  })

  it('retains the numeric diagnostic for a settled unexpected state', async () => {
    await expect(assertEntriesActivated(ctxWith([
      { fiber: fiber(4), options: { name: 'disposed' } },
    ]), NAME)).rejects.toThrow('disposed: fiber state 4')
  })
})

describe('loadOverlayPatches', () => {
  it('loads expressions and rejects missing, malformed, non-array, and non-mapping overlays', () => {
    const dir = tmp()
    const valid = join(dir, 'valid.yml')
    writeFileSync(valid, '- id: target\n  config:\n    value: !!js process.env.VALUE\n')
    expect(loadOverlayPatches(NAME, valid)).toEqual([{ id: 'target', config: { value: { __jsExpr: 'process.env.VALUE' } } }])
    expect(() => loadOverlayPatches(NAME, join(dir, 'missing.yml'))).toThrow(`${NAME}: failed to read overlay`)
    const malformed = join(dir, 'malformed.yml')
    writeFileSync(malformed, ': bad')
    expect(() => loadOverlayPatches(NAME, malformed)).toThrow(`${NAME}: failed to parse overlay`)
    const mapping = join(dir, 'mapping.yml')
    writeFileSync(mapping, 'id: target\n')
    expect(() => loadOverlayPatches(NAME, mapping)).toThrow('must be a top-level YAML array')
    const scalar = join(dir, 'scalar.yml')
    writeFileSync(scalar, '- scalar\n')
    expect(() => loadOverlayPatches(NAME, scalar)).toThrow('entry 1')
  })
})

describe('boot', () => {
  it('boots a leaf config through the real Loader and settles the tree', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), 'export const name = "noop"\nexport function apply() {}\n')
    writeFileSync(join(dir, 'cordis.yml'), '- id: noop\n  name: ./noop.mjs\n')
    const ctx = await boot(NAME, join(dir, 'cordis.yml'))
    try {
      const entries = [...ctx.loader.entries()]
      expect(entries.some(entry => entry.options.name === './noop.mjs' && entry.fiber !== undefined)).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('can resolve bare plugins from the harness when the config project shadows their package name', async () => {
    const dir = tmp()
    const harness = tmp()
    const absolutePlugin = join(dir, 'absolute.mjs')
    const shadow = join(dir, 'node_modules', '@deepseek-ai', 'dsh-system-prompt')
    const harnessPlugin = join(harness, 'node_modules', '@deepseek-ai', 'dsh-system-prompt')
    mkdirSync(shadow, { recursive: true })
    mkdirSync(harnessPlugin, { recursive: true })
    writeFileSync(join(shadow, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-system-prompt',
      type: 'module',
      exports: './index.mjs',
    }))
    writeFileSync(join(shadow, 'index.mjs'), [
      'export function apply(ctx) {',
      '  ctx.provide("shadowPluginLoaded", true)',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(harnessPlugin, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-system-prompt',
      type: 'module',
      exports: './index.mjs',
    }))
    writeFileSync(join(harnessPlugin, 'index.mjs'), [
      'export function apply(ctx) {',
      '  ctx.provide("harnessPluginLoaded", true)',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'relative.mjs'), 'export function apply(ctx) { ctx.provide("relativePluginLoaded", true) }\n')
    writeFileSync(absolutePlugin, 'export function apply(ctx) { ctx.provide("absolutePluginLoaded", true) }\n')
    const entries = [
      '- id: prompt',
      "  name: '@deepseek-ai/dsh-system-prompt'",
      '- id: relative',
      "  name: './relative.mjs'",
    ]
    const configOwnedPath = join(dir, 'config-owned.cordis.yml')
    writeFileSync(configOwnedPath, [...entries, ''].join('\n'))
    const hostOwnedPath = join(dir, 'host-owned.cordis.yml')
    writeFileSync(hostOwnedPath, [
      ...entries,
      '- id: absolute',
      `  name: ${JSON.stringify(absolutePlugin)}`,
      '',
    ].join('\n'))
    const configOwned = await boot(NAME, configOwnedPath)
    try {
      expect(configOwned.get('shadowPluginLoaded')).toBe(true)
      expect(configOwned.get('systemPrompt')).toBeUndefined()
      expect(configOwned.get('relativePluginLoaded')).toBe(true)
    } finally {
      await configOwned.fiber.dispose()
    }
    const harnessBaseUrl = pathToFileURL(join(harness, 'entry.mjs')).href
    const ctx = await boot(NAME, hostOwnedPath, undefined, undefined, harnessBaseUrl)
    try {
      expect(ctx.get('harnessPluginLoaded')).toBe(true)
      expect(ctx.get('shadowPluginLoaded')).toBeUndefined()
      expect(ctx.get('relativePluginLoaded')).toBe(true)
      expect(ctx.get('absolutePluginLoaded')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('runs host preparation before the Loader tree mounts', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), 'export const name = "noop"\nexport function apply() {}\n')
    writeFileSync(join(dir, 'cordis.yml'), '- id: noop\n  name: ./noop.mjs\n')
    const prepared: Context[] = []
    const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, (hostCtx) => {
      expect(hostCtx.loader).toBeDefined()
      expect([...hostCtx.loader.entries()]).toEqual([])
      prepared.push(hostCtx)
    })
    try {
      expect(prepared).toEqual([ctx])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('disposes partial host setup and labels non-Error preparation failures', async () => {
    const dir = tmp()
    const failure = 42
    let disposed = false
    const task = boot(NAME, join(dir, 'cordis.yml'), undefined, (ctx) => {
      ctx.effect(() => () => { disposed = true })
      throw failure
    })

    await expect(task).rejects.toMatchObject({
      message: `${NAME}: host preparation failed: ${failure}`,
      cause: failure,
    })
    expect(disposed).toBe(true)
  })

  it('exposes dshHomePath to Loader config expressions', async () => {
    const dir = tmp()
    const dshHome = join(dir, 'home')
    vi.stubEnv('DSH_HOME', dshHome)
    writeFileSync(join(dir, 'capture.mjs'), [
      'export const name = "capture"',
      'export function apply(ctx, config) {',
      '  ctx.provide("capturedPath", config.path)',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: capture',
      '  name: ./capture.mjs',
      '  config:',
      "    path: !!js dshHomePath('sessions')",
      '',
    ].join('\n'))
    let ctx: Context | undefined
    try {
      ctx = await boot(NAME, join(dir, 'cordis.yml'))
      expect(ctx.get('capturedPath')).toBe(join(dshHome, 'sessions'))
    } finally {
      await ctx?.fiber.dispose()
      vi.unstubAllEnvs()
    }
  })

  it('returns instead of asserting over a tree a surface disposed mid-startup', async () => {
    // A surface can dispose the root fiber while boot() is still awaiting the
    // Loader, before the last entry settles. The Loader service goes with the
    // tree, so reading it for the post-boot assertions would crash an app that
    // exited exactly as the user asked.
    const dir = tmp()
    writeFileSync(join(dir, 'exiting.mjs'), [
      'export const name = "exiting"',
      'export function apply(ctx) {',
      '  void ctx.root.fiber.dispose()',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'delayed.mjs'), [
      'await new Promise(resolve => setTimeout(resolve, 10))',
      'export function apply() {}',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cordis.yml'), [
      '- id: exiting',
      '  name: ./exiting.mjs',
      '- id: delayed',
      '  name: ./delayed.mjs',
      '',
    ].join('\n'))
    const ctx = await boot(NAME, join(dir, 'cordis.yml'))
    expect(ctx.get('loader')).toBeUndefined()
  })

  it('rejects (never exits 0 half-empty) when a config names a plugin that cannot be imported', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'cordis.yml'), '- id: ghost\n  name: ./missing.mjs\n')
    await expect(boot(NAME, join(dir, 'cordis.yml'))).rejects.toThrow(
      `${NAME}: plugin tree failed to load: failed to apply loader entry`,
    )
  })

  it('labels a deferred config failure with its row and leaves the source file unchanged', async () => {
    const dir = tmp()
    const configPath = join(dir, 'cordis.yml')
    const config = [
      '- id: invalid-config',
      '  name: ./noop.mjs',
      '  config:',
      '    value: !!js "JSON.parse(\'invalid\')"',
      '',
    ].join('\n')
    writeFileSync(join(dir, 'noop.mjs'), 'export function apply() {}\n')
    writeFileSync(configPath, config)

    await expect(boot(NAME, configPath)).rejects.toThrow(
      'failed to apply loader entry invalid-config (./noop.mjs)',
    )
    expect(readFileSync(configPath, 'utf8')).toBe(config)
  })

  it('appends the deepest cause with its original stack to the load failure', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'failing.mjs'), [
      'export function apply() {',
      "  const failure = new Error('pinned activation failure')",
      "  failure.stack = 'Error: pinned activation failure\\n    at failing-fixture'",
      '  throw failure',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cordis.yml'), '- id: failing\n  name: ./failing.mjs\n')
    await expect(boot(NAME, join(dir, 'cordis.yml'))).rejects.toThrow(new RegExp([
      String.raw`failed to apply loader entry failing \(\./failing\.mjs\): pinned activation failure\n`,
      String.raw`Error: pinned activation failure\n {4}at failing-fixture$`,
    ].join('')))
  })

  it('falls back to the deepest cause message when its stack was erased', async () => {
    const dir = tmp()
    const deepest = new Error('stackless deep failure')
    delete (deepest as { stack?: string }).stack
    await expect(boot(NAME, join(dir, 'cordis.yml'), undefined, () => {
      throw new Error('wrapped setup failure', { cause: deepest })
    })).rejects.toThrow(
      `${NAME}: host preparation failed: wrapped setup failure\nstackless deep failure`,
    )
  })

  it('expands a stackless aggregate at the deepest activation cause', async () => {
    const dir = tmp()
    const aggregate = new AggregateError([
      new Error('first aggregate member'),
      'second aggregate member',
    ], 'aggregate activation failure')
    delete (aggregate as { stack?: string }).stack
    try {
      await boot(NAME, join(dir, 'cordis.yml'), undefined, () => {
        throw new Error('wrapped aggregate failure', { cause: aggregate })
      })
      expect.fail('boot should reject the aggregate activation failure')
    } catch (error) {
      expect(error).toBeInstanceOf(Error)
      const message = (error as Error).message
      expect(message).toContain(`${NAME}: host preparation failed: wrapped aggregate failure`)
      expect(message).toContain('aggregate activation failure')
      expect(message).toContain('first aggregate member')
      expect(message).toContain('second aggregate member')
    }
  })

  it('reports a pending real Loader fiber and the service unresolved in its own context', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'waiting.mjs'), 'export const inject = ["neverProvided"]\nexport function apply() {}\n')
    writeFileSync(join(dir, 'cordis.yml'), '- id: waiting\n  name: ./waiting.mjs\n')
    await expect(boot(NAME, join(dir, 'cordis.yml'))).rejects.toThrow([
      `${NAME}: 1 entry did not activate`,
      './waiting.mjs: pending (waiting for service: neverProvided)',
    ].join('\n'))
  })
})

describe('addHarnessSourceSection', () => {
  const SOURCE_ROOT = `${sep}opt${sep}harness-src`
  const EXPECTED = `The DeepSeek Harness implementation checkout is at ${SOURCE_ROOT}. The checkout location and current working directory are separate values and may differ; never infer the working directory from this path. Use pwd to determine the current working directory. Use this checkout only to inspect or extend DSH itself.`

  it('distinguishes the source path from the current workdir between identity and persona', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, { persona: 'You are a coding agent.' })
      const dispose = addHarnessSourceSection(ctx, SOURCE_ROOT)
      expect(dispose).toBeTypeOf('function')
      const systemPrompt = ctx.get('systemPrompt')!
      const rendered = renderPrompt(await systemPrompt.assemble())
      expect(rendered).toContain(EXPECTED)
      // The >= 0 guards keep a drifted opener/persona string from a false pass
      // through `-1 < n`.
      const identityAt = rendered.indexOf('You are an AI agent powered by DeepSeek Harness.')
      const sourceAt = rendered.indexOf(EXPECTED)
      const personaAt = rendered.indexOf('You are a coding agent.')
      expect(identityAt).toBeGreaterThanOrEqual(0)
      expect(personaAt).toBeGreaterThanOrEqual(0)
      expect(identityAt).toBeLessThan(sourceAt)
      expect(sourceAt).toBeLessThan(personaAt)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('is a no-op returning undefined when no systemPrompt service is mounted', async () => {
    const ctx = new Context()
    try {
      expect(addHarnessSourceSection(ctx, SOURCE_ROOT)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('disposes the section it added, so a systemPrompt reload leaves no residue', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SystemPrompt, {})
      const systemPrompt = ctx.get('systemPrompt')!
      const dispose = addHarnessSourceSection(ctx, SOURCE_ROOT)!
      const present = await systemPrompt.assemble()
      expect(present.sections.some(section => section.name === HARNESS_SOURCE_SECTION)).toBe(true)
      dispose()
      const gone = await systemPrompt.assemble()
      expect(gone.sections.some(section => section.name === HARNESS_SOURCE_SECTION)).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
