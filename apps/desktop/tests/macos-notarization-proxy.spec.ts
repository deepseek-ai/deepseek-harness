import { existsSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it as test, vi } from 'vitest'
import { restoreMacOSNotarizationProxy, withMacOSNotarizationProxy } from '../scripts/macos-notarization-proxy.ts'

// System proxy transactions use POSIX flock, which is unavailable on Windows.
const it = test.skipIf(process.platform === 'win32')

async function fixture(action: (fixture: ReturnType<typeof fakeSystem>, lock: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'mac-proxy-test-'))
  try { await action(fakeSystem(), join(root, 'lock')) } finally { await rm(root, { recursive: true, force: true }) }
}

function fakeSystem() {
  const states = {
    http: { enabled: false, server: 'old-http', port: 3128 },
    https: { enabled: true, server: 'old-https', port: 8080 },
  }
  const original = structuredClone(states)
  const control = { failSet: 0, setCount: 0, pac: false, authenticated: false, serverSpace: true, ignoreDisable: false }
  const ops = {
    reachable: vi.fn(async (_url: URL) => {}),
    ownerAlive: vi.fn((_pid: number) => false),
    command: vi.fn((executable: string, args: readonly string[]) => {
      if (executable === '/sbin/route') return '  interface: en9\n'
      if (args[0] === '-listnetworkserviceorder') return '(1) Ethernet\n(Hardware Port: USB LAN, Device: en9)\n\n(2) Wi-Fi\n(Hardware Port: Wi-Fi, Device: en0)\n'
      expect(args[1]).toBe('Ethernet')
      if (args[0] === '-getautoproxyurl') return `URL: http://pac\nEnabled: ${control.pac ? 'Yes' : 'No'}\n`
      if (args[0] === '-getproxyautodiscovery') return 'Auto Proxy Discovery: Off\n'
      if (args[0] === '-getsocksfirewallproxy') return 'Enabled: No\n'
      const state = args[0]!.includes('secure') ? states.https : states.http
      if (args[0]!.startsWith('-get')) return `Enabled: ${state.enabled ? 'Yes' : 'No'}\nServer:${control.serverSpace ? ' ' : ''}${state.server}\nPort: ${state.port}\nAuthenticated Proxy Enabled: ${control.authenticated ? '1' : '0'}\n`
      control.setCount++
      if (control.setCount === control.failSet) throw new Error('system write failed')
      if (args[0]!.endsWith('state')) {
        if (!(control.ignoreDisable && args[2] === 'off')) state.enabled = args[2] === 'on'
      }
      else { state.server = args[2]!; state.port = Number(args[3]); state.enabled = true }
      return ''
    }),
  }
  return { ops, states, original, control }
}

it('preserves the network when no Apple proxy is configured', async () => {
  await fixture(async ({ ops }, lock) => {
    await expect(withMacOSNotarizationProxy(undefined, async () => 42, lock, ops)).resolves.toBe(42)
    expect(ops.command).not.toHaveBeenCalled()
    expect(ops.reachable).not.toHaveBeenCalled()
    expect(existsSync(lock)).toBe(false)
  })
})

it.each([false, true])('restores both original proxies after settled work (failure=%s)', async (fail) => {
  await fixture(async ({ ops, states, original }, lock) => {
    const statuses: string[] = []
    const work = withMacOSNotarizationProxy('http://localhost:8888', async () => {
      expect(states.http).toEqual({ enabled: true, server: 'localhost', port: 8888 })
      expect(states.https).toEqual(states.http)
      const record = JSON.parse(readFileSync(join(lock, 'original.json'), 'utf8')) as { service: string }
      expect(record.service).toBe('Ethernet')
      if (fail) throw new Error('Apple refused')
      return 42
    }, lock, ops, (status) => { statuses.push(status) })
    if (fail) await expect(work).rejects.toThrow('Apple refused')
    else await expect(work).resolves.toBe(42)
    expect(statuses).toEqual(['restoration-pending', 'enabled', 'restored'])
    expect(states).toEqual(original)
    expect(existsSync(lock)).toBe(false)
  })
})

it.each([false, true])('disables originally empty proxies without writing empty endpoints (space=%s)', async (space) => {
  await fixture(async ({ ops, states, control }, lock) => {
    control.serverSpace = space
    states.http = { enabled: false, server: '', port: 0 }
    states.https = { enabled: false, server: '', port: 0 }
    await expect(withMacOSNotarizationProxy('http://localhost:8888', async () => {
      expect(states.http.enabled).toBe(true)
      expect(states.https.enabled).toBe(true)
      throw new Error('Apple refused')
    }, lock, ops)).rejects.toThrow('Apple refused')
    expect(states.http).toEqual({ enabled: false, server: 'localhost', port: 8888 })
    expect(states.https).toEqual(states.http)
    const setters = ops.command.mock.calls.filter(([, args]) => ['-setwebproxy', '-setsecurewebproxy'].includes(args[0]!))
    expect(setters).toHaveLength(2)
    expect(setters.every(([, args]) => args[2] === 'localhost')).toBe(true)
    expect(existsSync(lock)).toBe(false)
  })
})

it('retains an empty-proxy recovery record after failed disabling and retries it', async () => {
  await fixture(async ({ ops, states, control }, lock) => {
    states.http = { enabled: false, server: '', port: 0 }
    states.https = { enabled: false, server: '', port: 0 }
    control.failSet = 5
    await expect(withMacOSNotarizationProxy('http://localhost:8888', async () => {}, lock, ops)).rejects.toThrow('restoration failed')
    expect(existsSync(lock)).toBe(true)
    expect(states.http.enabled).toBe(true)
    expect(states.https.enabled).toBe(false)
    await restoreMacOSNotarizationProxy(lock, ops)
    expect(states.http.enabled).toBe(false)
    expect(states.https.enabled).toBe(false)
    expect(existsSync(lock)).toBe(false)
  })
})

it('keeps the recovery record when disabling an originally empty proxy has no effect', async () => {
  await fixture(async ({ ops, states, control }, lock) => {
    states.http = { enabled: false, server: '', port: 0 }
    control.ignoreDisable = true
    await expect(withMacOSNotarizationProxy('http://localhost:8888', async () => {}, lock, ops)).rejects.toThrow('restoration failed')
    expect(states.http.enabled).toBe(true)
    expect(existsSync(lock)).toBe(true)
    control.ignoreDisable = false
    await restoreMacOSNotarizationProxy(lock, ops)
    expect(states.http.enabled).toBe(false)
    expect(existsSync(lock)).toBe(false)
  })
})

it('does not steal a live lock and holds the proxy until concurrent work drains', async () => {
  await fixture(async ({ ops, states, original }, lock) => {
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const running = withMacOSNotarizationProxy('http://localhost:8888', async () => { entered.resolve(undefined); await finish.promise }, lock, ops)
    try {
      await entered.promise
      await expect(withMacOSNotarizationProxy('http://localhost:8889', async () => {}, lock, ops)).rejects.toThrow('another run')
      await expect(restoreMacOSNotarizationProxy(lock, ops)).rejects.toThrow('another run')
      expect(ops.ownerAlive).not.toHaveBeenCalled()
      expect(states.http.port).toBe(8888)
      expect(existsSync(lock)).toBe(true)
    } finally { finish.resolve(undefined); await running }
    expect(states).toEqual(original)
  })
})

it('excludes both operations across processes and releases ownership after forced exit', async () => {
  await fixture(async ({ ops, states, original, control }, lock) => {
    control.failSet = 5
    await expect(withMacOSNotarizationProxy('http://localhost:8888', async () => {}, lock, ops)).rejects.toThrow('restoration failed')
    const saved = readFileSync(join(lock, 'original.json'), 'utf8')
    // Coverage builds the addon, but does not emit the package's JavaScript entry.
    const flockSource = new URL('../../../native/system/packages/entry/src/flock.ts', import.meta.url).href
    const child = spawn(process.execPath, ['--input-type=module', '-e', `
      import { openSync } from 'node:fs';
      import { tryLockExclusive } from ${JSON.stringify(flockSource)};
      const fd = openSync(process.argv[1], 'a', 0o600);
      await tryLockExclusive(fd);
      process.send('locked');
      process.stdin.resume();
    `, `${lock}.flock`], { stdio: ['pipe', 'ignore', 'pipe', 'ipc'], env: { PATH: process.env.PATH } })
    const exited = once(child, 'exit')
    const closed = once(child, 'close')
    let stderr = ''
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-8192) })
    try {
      await Promise.race([
        once(child, 'message').then(([message]) => { expect(message).toBe('locked') }),
        closed.then(([code, signal]) => { throw new Error(`lock holder exited before readiness: ${code}/${signal}\n${stderr}`) }),
      ])
      ops.command.mockClear()
      ops.ownerAlive.mockClear()
      await expect(restoreMacOSNotarizationProxy(lock, ops)).rejects.toThrow('another run')
      await expect(withMacOSNotarizationProxy('http://localhost:8889', async () => {}, lock, ops)).rejects.toThrow('another run')
      expect(ops.command).not.toHaveBeenCalled()
      expect(ops.ownerAlive).not.toHaveBeenCalled()
      expect(readFileSync(join(lock, 'original.json'), 'utf8')).toBe(saved)
    } finally {
      child.kill('SIGKILL')
      await closed
    }
    expect(await exited).toEqual([null, 'SIGKILL'])
    await restoreMacOSNotarizationProxy(lock, ops)
    expect(states).toEqual(original)
    expect(existsSync(lock)).toBe(false)
    expect(existsSync(`${lock}.flock`)).toBe(true)
    await withMacOSNotarizationProxy('http://localhost:8889', async () => {}, lock, ops)
    expect(states).toEqual(original)
  })
})

it('restores partial setup and never calls Apple after a system write failure', async () => {
  await fixture(async ({ ops, states, original, control }, lock) => {
    control.failSet = 3
    const action = vi.fn(async () => {})
    await expect(withMacOSNotarizationProxy('http://localhost:8888', action, lock, ops)).rejects.toThrow('system write failed')
    expect(action).not.toHaveBeenCalled()
    expect(states).toEqual(original)
    expect(existsSync(lock)).toBe(false)
  })
})

it.each(['pac', 'authenticated'] as const)('rejects unpreservable %s settings before mutation', async (kind) => {
  await fixture(async ({ ops, states, original, control }, lock) => {
    control[kind] = true
    const action = vi.fn(async () => {})
    await expect(withMacOSNotarizationProxy('http://localhost:8888', action, lock, ops)).rejects.toThrow(/proxy|proxies/u)
    expect(control.setCount).toBe(0)
    expect(action).not.toHaveBeenCalled()
    expect(states).toEqual(original)
  })
})

it('fails unreachable proxies before acquiring a lock or changing settings', async () => {
  await fixture(async ({ ops }, lock) => {
    ops.reachable.mockRejectedValueOnce(new Error('unreachable'))
    await expect(withMacOSNotarizationProxy('http://localhost:8888', async () => {}, lock, ops)).rejects.toThrow('unreachable')
    expect(ops.command).not.toHaveBeenCalled()
    expect(existsSync(lock)).toBe(false)
  })
})

it('retains recovery data after failed restoration, rejects live owners, then recovers after owner exit', async () => {
  await fixture(async ({ ops, states, original, control }, lock) => {
    control.failSet = 5
    await expect(withMacOSNotarizationProxy('http://localhost:8888', async () => {}, lock, ops)).rejects.toThrow('restoration failed')
    expect(existsSync(join(lock, 'original.json'))).toBe(true)
    ops.ownerAlive.mockReturnValueOnce(true)
    await expect(restoreMacOSNotarizationProxy(lock, ops)).rejects.toThrow('still running')
    await restoreMacOSNotarizationProxy(lock, ops)
    expect(states).toEqual(original)
    expect(existsSync(lock)).toBe(false)
  })
})

it('rejects malformed saved state without invoking host commands', async () => {
  await fixture(async ({ ops, control }, lock) => {
    control.failSet = 5
    await expect(withMacOSNotarizationProxy('http://localhost:8888', async () => {}, lock, ops)).rejects.toThrow('restoration failed')
    await writeFile(join(lock, 'original.json'), '{"pid":-1}')
    ops.command.mockClear()
    await expect(restoreMacOSNotarizationProxy(lock, ops)).rejects.toThrow('invalid proxy recovery record')
    expect(ops.command).not.toHaveBeenCalled()
  })
})

it('defers interruption until work settles and removes its signal listeners after restoration', async () => {
  await fixture(async ({ ops, states, original }, lock) => {
    const before = process.listenerCount('SIGTERM')
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    const running = withMacOSNotarizationProxy('http://localhost:8888', async () => { entered.resolve(undefined); await finish.promise }, lock, ops)
    const result = expect(running).rejects.toThrow('interrupted by SIGTERM')
    try {
      await entered.promise
      // Deliver only the listener owned by this invocation; never signal the test runner or other suites.
      const listener = process.listeners('SIGTERM').at(-1)!
      listener('SIGTERM')
      expect(states.http.port).toBe(8888)
      expect(existsSync(lock)).toBe(true)
    } finally { finish.resolve(undefined); await result; stderr.mockRestore() }
    expect(states).toEqual(original)
    expect(process.listenerCount('SIGTERM')).toBe(before)
  })
})

it('retains both the Apple failure and restoration failure', async () => {
  await fixture(async ({ ops, control }, lock) => {
    control.failSet = 5
    const appleError = new Error('Apple refused')
    const result = withMacOSNotarizationProxy('http://localhost:8888', async () => { throw appleError }, lock, ops)
    await expect(result).rejects.toMatchObject({ errors: [appleError, expect.any(AggregateError)] })
    expect(existsSync(join(lock, 'original.json'))).toBe(true)
    await restoreMacOSNotarizationProxy(lock, ops)
  })
})
