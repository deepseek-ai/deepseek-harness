import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  CRASH_REPORTS_RETAINED, crashReportFileName, ERROR_SECTION_MAX_CHARS, pruneCrashReports, renderCrashReport, RendererConsoleTail,
  writeCrashReport,
  type CrashReportInput,
} from '../src/crash-report.ts'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function scratch(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-crash-'))
  roots.push(root)
  return root
}

const input = (overrides: Partial<CrashReportInput> = {}): CrashReportInput => ({
  source: 'host',
  phase: 'running',
  error: Object.assign(new Error("ENOENT: no such file or directory, open 'C:\\\\Temp\\\\dsh-subprocess-x\\\\out.log'"), {
    errno: -4058, code: 'ENOENT', syscall: 'open', path: 'C:\\Temp\\dsh-subprocess-x\\out.log',
  }),
  rendererConsole: [],
  app: { name: 'DeepSeek Harness', version: '0.1.7', platform: 'win32', arch: 'x64', electron: '44.0.0', node: '24.18.1', locale: 'zh_CN' },
  time: new Date('2026-09-22T10:30:00.123Z'),
  ...overrides,
})

it('names files by sortable time and source', () => {
  expect(crashReportFileName(new Date('2026-09-22T10:30:00.123Z'), 'web-boot')).toBe('crash-2026-09-22T10-30-00-123Z-web-boot.log')
})

it('renders the facts header, the inspected error with its properties and cause, and the renderer console', () => {
  const text = renderCrashReport(input({
    error: new Error('wrapper', { cause: input().error }),
    rendererConsole: ['dsh-app://app/assets/entry.js:12 client-modules: bundle script plugins/??a/client.js&rev=1 failed to load'],
  }))
  expect(text).toContain('time: 2026-09-22T10:30:00.123Z\nsource: host\nphase: running\napp: DeepSeek Harness 0.1.7\nplatform: win32 x64\nelectron: 44.0.0\nnode: 24.18.1\nlocale: zh_CN\n')
  expect(text).toContain('--- error ---\nError: wrapper')
  expect(text).toContain("syscall: 'open'")
  expect(text).toContain("path: 'C:\\\\Temp\\\\dsh-subprocess-x\\\\out.log'")
  expect(text).toContain('[cause]: Error: ENOENT')
  expect(text).toContain('--- renderer console (error level, oldest first) ---\ndsh-app://app/assets/entry.js:12 client-modules: bundle script')
  expect(text.endsWith('\n')).toBe(true)
})

it('prints the Host diagnostic verbatim in its own section when the Host reported one', () => {
  const diagnostic = "Error: profile has no cordis.yml\n    at load (index.js:1:1) {\n  code: 'ENOENT'\n}"
  const text = renderCrashReport(input({ error: new Error('profile has no cordis.yml'), hostDiagnostic: diagnostic }))
  expect(text).toContain(`--- host diagnostic (as reported by the Host process) ---\n${diagnostic}\n\n--- renderer console`)
  expect(renderCrashReport(input())).not.toContain('--- host diagnostic')
})

it('says so when no renderer console output was captured and keeps a long error message whole', () => {
  const text = renderCrashReport(input({ error: new Error('x'.repeat(20_000)) }))
  expect(text).toContain('(no error-level renderer console output was captured)')
  expect(text).toContain('x'.repeat(20_000))
})

it('writes an owner-only report into a directory it creates and returns its path', async () => {
  const root = await scratch()
  const directory = join(root, 'logs')
  const path = await writeCrashReport(directory, input())
  expect(path).toBe(join(directory, 'crash-2026-09-22T10-30-00-123Z-host.log'))
  expect(await readFile(path!, 'utf8')).toContain('source: host')
  if (process.platform !== 'win32') expect((await stat(path!)).mode & 0o777).toBe(0o600)
})

it('returns undefined and logs when the report cannot be written', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  const root = await scratch()
  const blocked = join(root, 'not-a-directory')
  await writeFile(blocked, '')
  expect(await writeCrashReport(blocked, input())).toBeUndefined()
  expect(error).toHaveBeenCalledWith('dsh desktop: crash report could not be written', expect.stringContaining('crash-'), expect.anything())
})

it('prunes only the oldest crash reports and leaves other files alone', async () => {
  const root = await scratch()
  const names = Array.from({ length: CRASH_REPORTS_RETAINED + 3 }, (_, index) =>
    crashReportFileName(new Date(Date.UTC(2026, 8, 1 + index)), 'main'))
  for (const name of names) await writeFile(join(root, name), '')
  const foreign = ['crash-notes.txt', 'crash-notes.log', 'crash-2026-09-01T00-00-00-000Z-unknown.log', 'update-journal.jsonl']
  for (const name of foreign) await writeFile(join(root, name), '')
  await pruneCrashReports(root)
  const remaining = (await readdir(root)).sort()
  expect(remaining).toEqual([...names.slice(3), ...foreign].sort())
})

it('cuts an oversized error section and says so', () => {
  const text = renderCrashReport(input({ error: new Error('y'.repeat(300 * 1024)) }))
  const section = text.slice(text.indexOf('--- error ---'), text.indexOf('--- renderer console'))
  expect(section.length).toBeLessThan(ERROR_SECTION_MAX_CHARS + 200)
  expect(section).toContain(`… (error section cut at ${String(ERROR_SECTION_MAX_CHARS)} characters)`)
})

it('treats a missing logs directory as nothing to prune', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {})
  await pruneCrashReports(join(await scratch(), 'absent'))
  expect(error).not.toHaveBeenCalled()
})

it('keeps the newest renderer console lines within the byte cap, never cutting a line', () => {
  const tail = new RendererConsoleTail(20)
  tail.push('a'.repeat(8))
  tail.push('b'.repeat(8))
  tail.push('c'.repeat(8))
  expect(tail.snapshot()).toEqual(['b'.repeat(8), 'c'.repeat(8)])
  tail.push('d'.repeat(40))
  expect(tail.snapshot()).toEqual(['d'.repeat(40)])
})
