/**
 * The worker host's log sink: the seam that makes a failing plugin visible.
 *
 * Cordis's `LoggerService` accepts every message and, with no exporter mounted,
 * only fills a ring buffer. No profile in this repository mounts one, so a
 * provider that fails and is skipped — the skill registry logs exactly that —
 * is indistinguishable from one that found nothing. The sink is exercised here
 * rather than trusted: a diagnostic that runs nothing is a diagnostic that
 * silently stops working.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installLogSink, type LogExporter, type LogMessage } from '../src/worker-host.ts'

/** Capture the exporter the sink registers, and the cordis renderer it asks for. */
function harness(): { register: () => LogExporter; requested: string[] } {
  const requested: string[] = []
  let registered: LogExporter | undefined
  const ctx = {
    loader: { internal: undefined },
    logger: { exporter: (exporter: LogExporter) => { registered = exporter; return undefined } },
    get: () => undefined,
    provide: () => {},
    plugin: async () => undefined,
    fiber: { dispose: async () => {} },
  }
  const require = (specifier: string): unknown => {
    requested.push(specifier)
    // Stand in for cordis's printf renderer: the sink's contract is that it
    // formats THROUGH it, not that it reimplements the format.
    return { Logger: { format: (_exporter: LogExporter, message: LogMessage) => `rendered(${message.args.join('|')})` } }
  }
  installLogSink(ctx, require)
  if (registered === undefined) throw new Error('the sink registered no exporter')
  const exporter = registered
  return { register: () => exporter, requested }
}

const message = (type: LogMessage['type'], name: string, ...args: unknown[]): LogMessage => ({ name, type, args })

// Console spies are installed on one shared object, so a surviving spy would
// carry the previous case's calls into the counting case below.
afterEach(() => { vi.restoreAllMocks() })

describe('worker host log sink', () => {
  it('registers one exporter and renders through cordis', () => {
    const { register, requested } = harness()
    expect(requested).toEqual(['@deepseek-ai/cordis'])
    // Colors off: the page console has no terminal escapes to interpret.
    expect(register().colors).toBe(false)
  })

  it('declares a verbosity gate that admits warnings', () => {
    // cordis's scale counts UP with verbosity (ERROR 0, INFO 1, WARN 2, DEBUG 3)
    // and it drops a message whose level EXCEEDS the exporter's, so an exporter
    // that declares nothing inherits INFO and never sees a warning. This case is
    // the one that matters: the sink exists for warnings, and getting the
    // comparison backwards makes it silently deliver nothing.
    const admits = (exporterLevel: number, messageLevel: number): boolean => exporterLevel >= messageLevel
    const gate = harness().register().levels.default
    expect(admits(gate, 2), 'warnings must pass the gate').toBe(true)
    expect(admits(gate, 0), 'errors must pass the gate').toBe(true)
    expect(admits(gate, 3), 'debug must not pass the gate').toBe(false)
  })

  it('reports a warning with its logger name, the way a skipped provider arrives', () => {
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    harness().register().export(message('warn', 'skill', 'provider "local" skipped: FS_IO_ERROR'))
    expect(warned).toHaveBeenCalledWith('skill: rendered(provider "local" skipped: FS_IO_ERROR)')
  })

  it('reports an error on the error channel', () => {
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {})
    harness().register().export(message('error', 'loader', 'boom'))
    expect(failed).toHaveBeenCalledWith('loader: rendered(boom)')
  })

  it('drops info and debug, which 131 plugin rows would bury the console with', () => {
    const logged = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warned = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const failed = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exporter = harness().register()
    exporter.export(message('info', 'timer', 'tick'))
    exporter.export(message('debug', 'loader', 'resolved'))
    expect([logged.mock.calls.length, warned.mock.calls.length, failed.mock.calls.length]).toEqual([0, 0, 0])
  })
})
