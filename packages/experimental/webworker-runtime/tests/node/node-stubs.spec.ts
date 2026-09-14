/**
 * The Node-compatibility layer's refusals and its small answering faces.
 *
 * Two contracts live here. Every replaced symbol must be PRESENT — a missing
 * CommonJS export degrades to `undefined` and fails at call time somewhere
 * unrelated — and every symbol the worker cannot honour must refuse while naming
 * itself, because these errors are routinely swallowed far from their cause and
 * the name is what places them in a worker session's console.
 *
 * The member lists are the tables the modules are checked against: adding a
 * refusing symbol without listing it here leaves it unproven, and listing one
 * that starts answering fails.
 */
import { describe, expect, it, vi } from 'vitest'
import { notAvailableError, notImplementedFail } from '../../src/node/notImplementedFail.ts'
import * as childProcess from '../../src/node/builtin_modules/implemented/child_process.ts'
import * as dnsPromises from '../../src/node/builtin_modules/mock/dns/promises.ts'
import * as net from '../../src/node/builtin_modules/mock/net.ts'
import * as sqlite from '../../src/node/builtin_modules/mock/sqlite.ts'
import * as stream from '../../src/node/builtin_modules/implemented/stream.ts'
import * as vm from '../../src/node/builtin_modules/mock/vm.ts'
import * as workerThreads from '../../src/node/builtin_modules/mock/worker_threads.ts'
import * as nodePty from '../../src/node/external_packages/node-pty.ts'
import * as piAi from '../../src/node/external_packages/pi-ai.ts'
import * as ripgrep from '../../src/node/external_packages/ripgrep.ts'
import * as ws from '../../src/node/external_packages/ws.ts'
import { REPLACED_EXTERNAL_PACKAGES } from '../../src/node/external_packages/replaced-externals.ts'
import * as os from '../../src/node/builtin_modules/implemented/os.ts'
import * as perfHooks from '../../src/node/builtin_modules/implemented/perf_hooks.ts'
import { DSH_HOME, DSH_TMP } from '../../src/storage/paths.ts'

/** Every refusal writes its message to the console before throwing; keep the run quiet. */
const quiet = (): void => { vi.spyOn(console, 'error').mockImplementation(() => {}) }

/** Symbols that refuse when called. */
const CALLED: [string, Record<string, unknown>, readonly string[]][] = [
  ['node:dns/promises', dnsPromises, ['lookup']],
  ['node:net', net, ['createServer', 'connect']],
  ['node:sqlite', sqlite, ['backup']],
  ['node:vm', vm, ['createContext', 'runInContext', 'runInNewContext', 'runInThisContext', 'isContext']],
  ['node:worker_threads', workerThreads, ['MessageChannel', 'MessagePort', 'markAsUntransferable', 'receiveMessageOnPort']],
  // The rest of `node:child_process` runs commands (see child-process.spec.ts);
  // these three need a real process, so they stay refusals.
  ['node:child_process', childProcess, ['execFileSync', 'execSync', 'fork']],
  ['node-pty', nodePty, ['spawn', 'open']],
  ['@deepseek-ai/pi-ai', piAi, [
    'createProvider', 'createModels', 'openAICompletionsApi', 'openAIResponsesApi', 'anthropicMessagesApi',
    'isContextOverflow', 'getSupportedThinkingLevels',
  ]],
]

/** Classes that refuse when constructed. */
const CONSTRUCTED: [string, Record<string, unknown>, readonly string[]][] = [
  ['node:sqlite', sqlite, ['DatabaseSync', 'StatementSync']],
  ['node:vm', vm, ['Script']],
  ['node:worker_threads', workerThreads, ['Worker']],
  ['node:perf_hooks', perfHooks, ['PerformanceObserver']],
  ['ws', ws, ['WebSocket']],
]

describe('not-implemented stubs', () => {
  it('names the module and the symbol, and reports before throwing', () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => {})
    const error = notAvailableError('node:zlib', 'gzipSync')
    expect(error.message).toBe('web-preview: node:zlib.gzipSync is not available in the worker host')
    expect(reported).toHaveBeenCalledWith(error.message)

    const stub = notImplementedFail('node:zlib', 'gzipSync')
    expect(() => stub()).toThrow(error.message)
  })

  for (const [module, namespace, members] of CALLED) {
    it(`${module} refuses ${String(members.length)} called symbol(s)`, () => {
      quiet()
      for (const member of members) {
        const value = namespace[member]
        expect(typeof value, member).toBe('function')
        expect(() => (value as () => unknown)(), member).toThrow(new RegExp(`${member}\\b.*not available in the worker host`))
      }
    })
  }

  for (const [module, namespace, members] of CONSTRUCTED) {
    it(`${module} refuses ${String(members.length)} constructed symbol(s)`, () => {
      quiet()
      for (const member of members) {
        const value = namespace[member]
        expect(typeof value, member).toBe('function')
        expect(() => new (value as new () => unknown)(), member).toThrow(/not available in the worker host/)
      }
    })
  }

  it('keeps the CommonJS interop marker and a default export on every replaced module', () => {
    for (const namespace of [dnsPromises, net, sqlite, vm, workerThreads, childProcess, stream, ws, nodePty, piAi, os, perfHooks]) {
      const holder = namespace as { __esModule?: unknown; default?: unknown }
      expect(holder.__esModule).toBe(true)
      expect(holder.default).toBeDefined()
    }
  })
})

describe('constructible-but-inert fakes', () => {
  it('a ws server constructs, accepts listeners, and refuses to carry an upgrade', () => {
    quiet()
    expect(ws.Server).toBe(ws.WebSocketServer)
    const server = new ws.WebSocketServer()
    expect(server.clients.size).toBe(0)
    expect(server.on()).toBe(server)
    expect(() => server.handleUpgrade()).toThrow(/WebSocketServer.handleUpgrade is not available/)
    expect(() => server.emit()).toThrow(/WebSocketServer.emit is not available/)
    let closed = false
    server.close(() => { closed = true })
    expect(closed).toBe(true)
  })
})

describe('replaced external packages', () => {
  it('lists the packages the loader serves from the bundle', () => {
    expect(REPLACED_EXTERNAL_PACKAGES).not.toContain('chokidar')
    expect(REPLACED_EXTERNAL_PACKAGES).not.toContain('@deepseek-ai/node-addon-system')
    expect(REPLACED_EXTERNAL_PACKAGES).not.toContain('@deepseek-ai/node-addon-system/landlock-run')
    expect(REPLACED_EXTERNAL_PACKAGES).toContain('ws')
  })

  it('answers the values callers read without invoking anything', () => {
    // The ripgrep binary path is read as data by its consumer.
    expect(typeof ripgrep.rgPath).toBe('string')
  })
})

describe('node:net address predicates', () => {
  it('classifies IPv4, IPv6, and neither', () => {
    expect([net.isIPv4('127.0.0.1'), net.isIPv4('255.255.255.255')]).toEqual([true, true])
    expect([net.isIPv4('256.0.0.1'), net.isIPv4('::1'), net.isIPv4('nope')]).toEqual([false, false, false])
    expect([net.isIPv6('::1'), net.isIPv6('fe80::1'), net.isIPv6('127.0.0.1')]).toEqual([true, true, false])
    expect([net.isIP('127.0.0.1'), net.isIP('::1'), net.isIP('nope')]).toEqual([4, 6, 0])
  })

  it('constructs a Socket but refuses to move bytes through it', () => {
    const socket = new net.Socket()
    expect(() => socket.write()).toThrow(/Socket.write is not available/)
    expect(() => socket.end()).toThrow(/Socket.end is not available/)
    // Disposal paths run against sockets that were never connected.
    expect(() => { socket.destroy() }).not.toThrow()
  })
})

describe('node:os', () => {
  it('reports the virtual platform identity and the VFS directories', () => {
    expect([os.EOL, os.tmpdir(), os.homedir()]).toEqual(['\n', DSH_TMP, DSH_HOME])
    expect([os.platform(), os.type(), os.arch()]).toEqual(['linux', 'Linux', 'x64'])
    expect([os.release(), os.hostname()]).toEqual(['0.0.0-dsh-worker', 'dsh-worker'])
  })

  it('reports no per-core facts and no network interfaces', () => {
    expect(os.cpus()).toEqual([])
    // The worker webserver binds the loopback literal, so a LAN address is never
    // derived — and an empty record keeps it out of the trust snapshot.
    expect(os.networkInterfaces()).toEqual({})
    expect(os.availableParallelism()).toBeGreaterThanOrEqual(1)
  })

  it('maps the terminal signal names its consumer reads', () => {
    expect(os.constants.signals.SIGTERM).toBe(15)
    expect(os.constants.signals.SIGKILL).toBe(9)
  })
})

describe('node:perf_hooks', () => {
  it("hands over the worker's own clock", () => {
    expect(perfHooks.performance).toBe(globalThis.performance)
    expect(perfHooks.performance.now()).toBeGreaterThan(0)
  })
})
