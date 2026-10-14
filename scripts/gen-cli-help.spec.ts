/** Command discovery and complete output preservation for the CLI reference. */

import { describe, expect, it } from 'vitest'
import { collectCliHelp, parseCliHelp, prefetchHelp, topLevelHelpArgs } from './gen-cli-help.ts'

interface PendingRead {
  args: string
  signal: AbortSignal
  resolve(stdout: string): void
  reject(error: Error): void
}

/** A read function whose calls stay pending until the test settles them. */
function controlledReads(): { reads: PendingRead[]; read: (args: readonly string[], signal: AbortSignal) => Promise<string> } {
  const reads: PendingRead[] = []
  return {
    reads,
    read: (args, signal) => new Promise<string>((resolve, reject) => {
      reads.push({ args: args.join(' '), signal, resolve, reject })
    }),
  }
}

/** Let every queued promise continuation run. */
async function flush(): Promise<void> {
  await new Promise<void>((resolve) => { setImmediate(resolve) })
}

describe('CLI help discovery', () => {
  it('reads command rows while retaining wrapped descriptions and examples', () => {
    const help = 'Usage: dsh\r\n\r\nCommands:\r\n  web [options]  Serve the browser\r\n                 with a wrapped description\r\n  plugin         Manage plugins\r\n\r\nExamples:\r\n  dsh web\r\n'
    const result = parseCliHelp(help)
    expect(result.commands).toEqual(['web', 'plugin'])
    expect(result.output).toBe(help.replaceAll('\r\n', '\n'))
  })

  it('includes plugin, both profile forms, and their nested commands when launcher help has no command list', async () => {
    const visited: string[] = []
    const pages = await collectCliHelp(async (args) => {
      visited.push(args.join(' '))
      if (args.length === 0) return 'Usage: dsh [--profile] <name>\n'
      if (args[0] === 'plugin') return 'Usage: dsh plugin --profile <name> <args...>\n'
      const selected = args[0] === '--profile' ? args.slice(1) : args
      if (selected[1] === 'nested') return 'Usage: nested\n'
      return `Usage: ${selected[0]} [command]\n\nCommands:\n  nested  Run the nested command\n`
    }, ['web'])
    expect(visited).toEqual(['', 'plugin', 'web', 'web nested', '--profile web'])
    expect(pages.map(page => page.invocations)).toEqual([
      ['dsh'], ['dsh plugin'], ['dsh web', 'dsh --profile web'],
      ['dsh web nested', 'dsh --profile web nested'],
    ])
  })

  it('visits each command alias and lists a help command that repeats its parent once', async () => {
    const visited: string[] = []
    const parent = 'Usage: web [command]\n\nCommands:\n  serve|s [options]  Serve the UI\n  help [command]     display help for command\n'
    const pages = await collectCliHelp(async (args) => {
      visited.push(args.join(' '))
      if (args.length === 0) return 'Usage: dsh\n'
      if (args[0] === 'plugin') return 'Usage: dsh plugin\n'
      const selected = args[0] === '--profile' ? args.slice(1) : args
      return selected[1] === 'serve' || selected[1] === 's' ? 'Usage: web serve\n' : parent
    }, ['web'])
    expect(visited).toEqual(['', 'plugin', 'web', 'web serve', 'web s', 'web help', '--profile web'])
    expect(pages.map(page => page.invocations)).toEqual([
      ['dsh'], ['dsh plugin'], ['dsh web', 'dsh web help', 'dsh --profile web', 'dsh --profile web help'],
      ['dsh web serve', 'dsh web s', 'dsh --profile web serve', 'dsh --profile web s'],
    ])
  })

  it.each(['', ' \r\n\n'])('rejects blank help %j', (help) => {
    expect(() => parseCliHelp(help)).toThrow('CLI help returned empty output')
  })

  it('lists top-level invocations in visit order', async () => {
    const visited: string[] = []
    await collectCliHelp(async (args) => {
      visited.push(args.join(' '))
      return `Usage: ${args.join(' ')}\n`
    }, ['web', 'acp'])
    expect(topLevelHelpArgs(['web', 'acp']).map(args => args.join(' '))).toEqual(visited)
    expect(visited).toEqual(['', 'plugin', 'acp', '--profile acp', 'web', '--profile web'])
  })
})

describe('CLI help prefetch', () => {
  it('starts prefetched reads within the limit and serves them in request order', async () => {
    const { reads, read } = controlledReads()
    const reader = prefetchHelp(read, [['a'], ['b'], ['c']], 2)
    await flush()
    expect(reads.map(entry => entry.args)).toEqual(['a', 'b'])
    reads[1]?.resolve('B')
    await flush()
    expect(reads.map(entry => entry.args)).toEqual(['a', 'b', 'c'])
    reads[0]?.resolve('A')
    reads[2]?.resolve('C')
    await expect(reader.readHelp(['a'])).resolves.toBe('A')
    await expect(reader.readHelp(['b'])).resolves.toBe('B')
    await expect(reader.readHelp(['c'])).resolves.toBe('C')
    const nested = reader.readHelp(['c', 'nested'])
    const repeated = reader.readHelp(['a'])
    await flush()
    expect(reads.map(entry => entry.args)).toEqual(['a', 'b', 'c', 'c nested', 'a'])
    reads[3]?.resolve('N')
    reads[4]?.resolve('A again')
    await expect(nested).resolves.toBe('N')
    await expect(repeated).resolves.toBe('A again')
    await reader.close()
  })

  it('reports a failure when its invocation is requested and settles started reads on close', async () => {
    const { reads, read } = controlledReads()
    const reader = prefetchHelp(read, [['a'], ['b'], ['c']], 1)
    await flush()
    const failure = new Error('a failed')
    reads[0]?.reject(failure)
    await flush()
    expect(reads.map(entry => entry.args)).toEqual(['a', 'b'])
    await expect(reader.readHelp(['a'])).rejects.toBe(failure)
    let closed = false
    const closing = reader.close().then(() => { closed = true })
    await flush()
    expect(reads[1]?.signal.aborted).toBe(true)
    expect(closed).toBe(false)
    reads[1]?.reject(new Error('b aborted'))
    await closing
    expect(reads.map(entry => entry.args)).toEqual(['a', 'b'])
    await expect(reader.readHelp(['c'])).rejects.toMatchObject({ name: 'AbortError' })
  })

  it.each([0, 1.5])('rejects concurrency %j', (concurrency) => {
    expect(() => prefetchHelp(async () => '', [], concurrency)).toThrow('concurrency must be a positive integer')
  })
})
