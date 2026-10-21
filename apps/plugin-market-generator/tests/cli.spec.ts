/** Command-line parsing and help of the generator. */
import { afterEach, expect, it, vi } from 'vitest'
import { main } from '../src/cli.ts'

afterEach(() => { vi.restoreAllMocks() })

/** Run the CLI and collect what it writes to stdout and stderr. */
async function cli(...argv: string[]) {
  const out: string[] = []
  const err: string[] = []
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { out.push(String(chunk)); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { err.push(String(chunk)); return true })
  const status = await main(argv)
  return { status, out: out.join(''), err: err.join('') }
}

const REQUIRED = ['--input', '/nonexistent/list.txt', '--output', '/nonexistent/index.json', '--title', 'T']

it('prints help with every option, its default, and the exit statuses', async () => {
  const { status, out } = await cli('--help')
  expect(status).toBe(0)
  for (const text of ['--input <file>', '--inline-icon-bytes <n>', 'at most 32768', '(default: 16384)', 'Exit status: 0 when every source was read']) {
    expect(out).toContain(text)
  }
})

it.each([
  [['--inline-icon-bytes', '32769'], "option '--inline-icon-bytes <n>' argument '32769' is invalid. must be a positive integer up to 32768"],
  [['--inline-icon-bytes', '0'], 'must be a positive integer up to 32768'],
  [['--concurrency', '1.5'], "option '--concurrency <n>' argument '1.5' is invalid. must be a positive integer"],
  [['--bogus'], "unknown option '--bogus'"],
])('refuses %j before reading the source list', async (extra, message) => {
  const { status, err } = await cli(...REQUIRED, ...extra)
  expect(status).toBe(2)
  expect(err).toContain(message)
})

it('names a missing required option', async () => {
  const { status, err } = await cli('--input', 'list.txt')
  expect(status).toBe(2)
  expect(err).toContain("required option '--output <file>' not specified")
  expect(err).toContain('(run with --help for usage)')
})

it('reports a source list it cannot read', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  expect(await main(REQUIRED)).toBe(2)
  expect(String(error.mock.calls[0]?.[0])).toContain('ENOENT')
})
