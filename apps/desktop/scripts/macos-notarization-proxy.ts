/** Temporarily route Apple tools through the active macOS service; retain recovery data before mutation. */

import { execFileSync } from 'node:child_process'
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { loadFlockEntry } from './flock-entry.ts'

interface ProxyState {
  readonly enabled: boolean
  readonly server: string
  readonly port: number
}
interface ProxyRecord {
  readonly pid: number
  readonly service: string
  readonly http: ProxyState
  readonly https: ProxyState
}
interface ProxyOperations {
  readonly command: (executable: string, args: readonly string[]) => string
  readonly reachable: (url: URL) => Promise<void>
  readonly ownerAlive: (pid: number) => boolean
}

const LOCK = join(homedir(), 'Library', 'Caches', 'com.deepseek.harness', 'notarization-proxy')
const RECOVERY = 'pnpm --dir apps/desktop run restore:mac-proxy'
const NETWORKSETUP = '/usr/sbin/networksetup'
const operations: ProxyOperations = {
  command(executable, args) {
    return execFileSync(executable, [...args], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C' }, timeout: 15_000 })
  },
  reachable(url) {
    return new Promise((resolveConnection, reject) => {
      const socket = connect({ host: url.hostname.replace(/^\[|\]$/gu, ''), port: Number(url.port || '80') })
      let failure: Error | undefined
      socket.setTimeout(5000, () => socket.destroy(new Error('desktop package: notarization proxy connection timed out')))
      socket.once('error', () => { failure = new Error('desktop package: notarization proxy is unreachable') })
      socket.once('connect', () => socket.destroy())
      socket.once('close', () => { if (failure) reject(failure); else resolveConnection() })
    })
  },
  ownerAlive(pid) {
    try { process.kill(pid, 0); return true } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
      throw error
    }
  },
}

async function withProxyLock<T>(lock: string, action: () => Promise<T>): Promise<T> {
  const { tryLockExclusive } = await loadFlockEntry()
  mkdirSync(dirname(lock), { recursive: true, mode: 0o700 })
  // Keep this inode across transactions: unlinking it would allow two independent locks.
  const fd = openSync(`${lock}.flock`, 'a', 0o600)
  try {
    try { await tryLockExclusive(fd) } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EAGAIN' && code !== 'EWOULDBLOCK') throw error
      throw new Error('desktop package: another run or proxy recovery is active; wait for it to finish')
    }
    return await action()
  } finally { closeSync(fd) }
}

function readProxy(service: string, secure: boolean, ops: ProxyOperations): ProxyState {
  const output = ops.command(NETWORKSETUP, [secure ? '-getsecurewebproxy' : '-getwebproxy', service])
  const enabled = /^Enabled: (Yes|No)$/mu.exec(output)?.[1]
  const server = /^Server:[ \t]?(.*)$/mu.exec(output)?.[1]
  const port = /^Port: (\d+)$/mu.exec(output)?.[1]
  if (enabled === undefined || server === undefined || port === undefined
    || !/^Authenticated Proxy Enabled: 0$/mu.test(output) || Number(port) > 65535) {
    throw new Error('desktop package: cannot preserve system proxy settings; authenticated proxies are unsupported')
  }
  return { enabled: enabled === 'Yes', server, port: Number(port) }
}

function activeService(ops: ProxyOperations): string {
  const route = ops.command('/sbin/route', ['-n', 'get', 'default'])
  const device = /^\s*interface: (\S+)$/mu.exec(route)?.[1]
  const services = ops.command(NETWORKSETUP, ['-listnetworkserviceorder'])
  const matches = [...services.matchAll(/^\(\d+\) (.+)\n\(Hardware Port: .+, Device: ([^)]+)\)$/gmu)]
    .filter(match => match[2] === device)
  if (!device || matches.length !== 1) throw new Error('desktop package: cannot identify one active network service for notarization proxy')
  return matches[0]![1]!
}

function setProxy(service: string, secure: boolean, state: ProxyState, ops: ProxyOperations): void {
  ops.command(NETWORKSETUP, [secure ? '-setsecurewebproxy' : '-setwebproxy', service, state.server, String(state.port), 'off'])
  ops.command(NETWORKSETUP, [secure ? '-setsecurewebproxystate' : '-setwebproxystate', service, state.enabled ? 'on' : 'off'])
  const actual = readProxy(service, secure, ops)
  if (JSON.stringify(actual) !== JSON.stringify(state)) throw new Error('desktop package: system proxy change did not take effect')
}

function restore(record: ProxyRecord, ops: ProxyOperations): void {
  const errors: unknown[] = []
  for (const [secure, state] of [[false, record.http], [true, record.https]] as const) {
    try {
      if (!state.enabled && state.server === '' && state.port === 0) {
        ops.command(NETWORKSETUP, [secure ? '-setsecurewebproxystate' : '-setwebproxystate', record.service, 'off'])
        if (readProxy(record.service, secure, ops).enabled) throw new Error('desktop package: system proxy disable did not take effect')
      } else setProxy(record.service, secure, state, ops)
    } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, `desktop package: proxy restoration failed; retry ${RECOVERY}`)
}

function readRecord(lock: string): ProxyRecord {
  const value: unknown = JSON.parse(readFileSync(join(lock, 'original.json'), 'utf8'))
  function isState(state: unknown): state is ProxyState {
    if (state === null || typeof state !== 'object') return false
    const s = state as Partial<ProxyState>
    return typeof s.enabled === 'boolean' && typeof s.server === 'string' && !/[\r\n\0]/u.test(s.server)
      && typeof s.port === 'number' && Number.isInteger(s.port) && s.port >= 0 && s.port <= 65535
  }
  if (value === null || typeof value !== 'object') throw new Error('desktop package: invalid proxy recovery record')
  const record = value as Partial<ProxyRecord>
  if (!Number.isSafeInteger(record.pid) || record.pid! <= 0 || typeof record.service !== 'string'
    || !record.service || /[\r\n\0]/u.test(record.service) || !isState(record.http) || !isState(record.https)) {
    throw new Error('desktop package: invalid proxy recovery record')
  }
  return record as ProxyRecord
}

/**
 * Restore an interrupted run only after its owner exits; active or incomplete records fail closed.
 * Originally empty proxies are disabled; their temporary server and port may remain stored.
 * @param lock Per-user lock shared across checkouts; tests supply a private directory.
 * @param ops Host operations; tests supply isolated system settings.
 * @returns Resolves after restoration under the shared file lock; retains the record on failure.
 */
export async function restoreMacOSNotarizationProxy(lock: string = LOCK, ops: ProxyOperations = operations): Promise<void> {
  await withProxyLock(lock, async () => {
    const record = readRecord(lock)
    if (ops.ownerAlive(record.pid)) throw new Error('desktop package: proxy owner is still running; wait for packaging to finish')
    restore(record, ops)
    rmSync(lock, { recursive: true })
  })
}

/**
 * Hold the system HTTP/HTTPS proxy until all callback work settles, including after SIGINT/SIGTERM.
 * @param proxyUrl Validated HTTP proxy origin, or undefined for unchanged system networking.
 * @param action Work that drains every notarization lane before resolving or rejecting.
 * @param lock Per-user exclusive recovery directory, shared across checkouts.
 * @param ops Host operations; tests supply isolated system settings.
 * @param report Reports restoration state to the packaging journal without exposing proxy addresses.
 * @returns Callback result after verified restoration; forced termination leaves a recovery record.
 */
export async function withMacOSNotarizationProxy<T>(
  proxyUrl: string | undefined,
  action: () => Promise<T>,
  lock: string = LOCK,
  ops: ProxyOperations = operations,
  report: (status: 'not-used' | 'restoration-pending' | 'enabled' | 'restored' | 'restore-failed') => void = () => {},
): Promise<T> {
  if (proxyUrl === undefined) { report('not-used'); return action() }
  const url = new URL(proxyUrl)
  await ops.reachable(url)
  return withProxyLock(lock, async () => {
    try { mkdirSync(lock, { mode: 0o700 }) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      throw new Error(`desktop package: another run or interrupted proxy record exists; after its owner exits, run ${RECOVERY}`)
    }
    let original: ProxyRecord | undefined
    let saved = false
    let workError: unknown
    let signal: string | undefined
    const interrupted = (received: string) => {
      signal = received
      process.stderr.write('desktop package: waiting for notarization work to stop before restoring the system proxy\n')
    }
    process.on('SIGINT', interrupted)
    process.on('SIGTERM', interrupted)
    try {
      const service = activeService(ops)
      // PAC, discovery and SOCKS can override explicit proxies; do not silently change those policies.
      const pac = ops.command(NETWORKSETUP, ['-getautoproxyurl', service])
      const discovery = ops.command(NETWORKSETUP, ['-getproxyautodiscovery', service])
      const socks = ops.command(NETWORKSETUP, ['-getsocksfirewallproxy', service])
      if (!/^Enabled: No$/mu.test(pac) || !/^Auto Proxy Discovery: Off$/mu.test(discovery) || !/^Enabled: No$/mu.test(socks)) {
        throw new Error('desktop package: disable PAC, proxy discovery and SOCKS on the active service before configuring a notarization proxy')
      }
      original = { pid: process.pid, service, http: readProxy(service, false, ops), https: readProxy(service, true, ops) }
      writeFileSync(join(lock, 'original.json'), `${JSON.stringify(original)}\n`, { flag: 'wx', mode: 0o600, flush: true })
      saved = true
      report('restoration-pending')
      const state = { enabled: true, server: url.hostname.replace(/^\[|\]$/gu, ''), port: Number(url.port || '80') }
      setProxy(service, false, state, ops)
      setProxy(service, true, state, ops)
      report('enabled')
      const result = await action()
      if (signal) throw new Error(`desktop package: interrupted by ${signal}`)
      return result
    } catch (error) {
      workError = error
      throw error
    } finally {
      try {
        if (saved && original) {
          try { restore(original, ops) } catch (error) { report('restore-failed'); throw error }
          report('restored')
        }
        rmSync(lock, { recursive: true })
      } catch (error) {
        if (workError !== undefined) {
          throw new AggregateError([workError, error], `desktop package: work and proxy cleanup failed; run ${RECOVERY}`)
        }
        throw error
      } finally {
        process.off('SIGINT', interrupted)
        process.off('SIGTERM', interrupted)
      }
    }
  })
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) {
  if (process.platform !== 'darwin') throw new Error('desktop package: proxy recovery requires macOS')
  await restoreMacOSNotarizationProxy()
  console.log('desktop package: original system proxy restored')
}
