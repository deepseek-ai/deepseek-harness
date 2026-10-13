/** Real-agent Excel validation through the shipped headless profile; requires a built primary runtime. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it, onTestFinished } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { readImageFile } from '@deepseek-ai/dsh-attachment-local'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expectNoRenderContext, officeModelPatches } from './fixtures/real-office.ts'
import { renderCliFixture } from './fixtures/render-cli.ts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const assetRoot = fileURLToPath(new URL('../assets/', import.meta.url))
// DSH_PRIMARY_RUNTIME names the same runtime.json + dependencies/ payload used by shipped deployments.
const runtime = process.env.DSH_PRIMARY_RUNTIME
const python = runtime && join(runtime, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
const seed = `
import sys
from openpyxl import Workbook
w = Workbook()
s = w.active
s.title = 'Revenue'
for row in [('Quarterly revenue', 'Amount'), ('Q1', 12), ('Q2', 18)]:
    s.append(row)
s.column_dimensions['A'].width = 5 if sys.argv[1] in ('layout', 'blank') else 24
s.column_dimensions['B'].width = 5 if sys.argv[1] in ('layout', 'blank') else 12
w.create_sheet('Notes')['A1'] = 'Preserve this note'
w.save('input.xlsx')
`

const previewPixels = `
import io, sys
from PIL import Image
im = Image.open(io.BytesIO(sys.stdin.buffer.read())).convert('RGBA')
visible = Image.alpha_composite(Image.new('RGBA', im.size, 'white'), im).convert('RGB')
print('content' if any(low != high for low, high in visible.getextrema()) else 'blank')
`

const cases = [
  {
    name: 'data edits with basic styling skip visual inspection',
    task: 'Change Revenue!B2 to 20 and add Q3 with revenue 7 in A4:B4. Bold the header row and show revenue as whole numbers.',
    kind: 'data',
  },
  {
    name: 'formula edits refresh cached results without rendering',
    task: 'Change Revenue!B2 to 20, set A4 to Total and B4 to =SUM(B2:B3). The delivered workbook must contain the formula and its updated calculated result.',
    kind: 'formula',
  },
  {
    name: 'layout edits inspect the affected worksheet region',
    task: 'Fix the cramped layout of Revenue!A1:B3: make the column headers fully readable and the amounts easy to read. Adjust column widths and header styling, then visually inspect the final affected range.',
    kind: 'layout',
  },
  {
    name: 'blank previews end visual checking without changing print settings',
    task: 'Fix the cramped layout of Revenue!A1:B3: make the column headers fully readable and the amounts easy to read. Adjust column widths and header styling, then visually inspect the final affected range.',
    kind: 'blank',
  },
] as const

describe.skipIf(!process.env.DEEPSEEK_API_KEY || !runtime).each(['native', 'ptc'])('Excel validation scope (%s)', (mode) => {
  it.each(mode === 'native' ? cases : cases.filter(({ kind }) => kind === 'layout'))('$name', async ({ task, kind }) => {
    let events: SessionEvent[] = []
    let original: Buffer | undefined
    let previewHasContent = false
    let fixtureCalls: { args: string[]; status: number | null }[] = []
    const controlRoot = await mkdtemp(join(tmpdir(), 'dsh-xlsx-control-test-'))
    onTestFinished(() => rm(controlRoot, { recursive: true, force: true }))
    const configPath = join(controlRoot, 'office.patch.json')
    const sessionRoot = join(controlRoot, 'sessions'), imageRoot = join(controlRoot, 'image-store')
    await runLoaderSmoke({
      label: `Excel ${kind} validation`,
      tempDirPrefix: 'dsh-xlsx-validation-',
      binScript: join(repo, 'apps/cli/src/bin.ts'),
      sourceImport: 'tsx/esm',
      tsconfigPath: join(repo, 'tsconfig.base.json'),
      configPath,
      binArgs: ['--profile', 'headless', '--patch', configPath,
        `${task} Use input.xlsx and save the finished workbook as result.xlsx. Preserve the Notes sheet and leave input.xlsx unchanged. Respond briefly in English.`,
      ],
      processTimeoutMs: 110_000,
      env: {
        DSH_PRIMARY_RUNTIME: runtime,
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_HOME: join(controlRoot, 'home'),
        DSH_AGENTS_HOME: join(controlRoot, 'agents'),
        DSH_TELEMETRY_DISABLED: '1',
        DSH_TOOLS_MODE: mode,
        HTTP_PROXY: process.env.DSH_OFFICE_TEST_PROXY,
        HTTPS_PROXY: process.env.DSH_OFFICE_TEST_PROXY,
      },
      async prepare(cwd) {
        await execa(python!, ['-c', seed, kind], { cwd })
        original = await readFile(join(cwd, 'input.xlsx'))
        const fixture = kind === 'blank' || kind === 'formula'
          ? await renderCliFixture(controlRoot, python!, kind === 'blank') : undefined
        await writeFile(configPath, JSON.stringify([
          { insert: [{ id: 'skill-office', name: '@deepseek-ai/dsh-skill-office', config: { assetRoot, node: process.execPath, ...fixture ? { cli: fixture.cli } : {} } }] },
          { insert: [{ id: 'workspace-dependencies', name: '@deepseek-ai/dsh-tool-workspace-dependencies', config: { source: runtime! } }] },
          ...officeModelPatches(),
          { id: 'attachment-local', config: { dshHome: imageRoot } },
          { id: 'session-persistence-jsonl', config: { root: sessionRoot, compression: 'none' } },
        ]))
      },
      async inspect(cwd) {
        const paths = await readdir(sessionRoot, { recursive: true })
        const logs = paths.filter(path => /session\.v\d+\.jsonl$/u.test(path))
        expect(logs).toHaveLength(1)
        const bytes = await readFile(join(sessionRoot, logs[0]!))
        const traceDir = process.env.DSH_OFFICE_TRACE_DIR
        if (traceDir !== undefined) {
          await mkdir(traceDir, { recursive: true })
          await writeFile(join(traceDir, `xlsx-${kind}-${mode}.jsonl`), bytes)
        }
        events = parseSessionLog(bytes.toString('utf8'))
        expect(await readFile(join(cwd, 'input.xlsx'))).toEqual(original)
        const verified = await execa(python!, ['-c', `
from openpyxl import load_workbook
w = load_workbook('result.xlsx', data_only=False)
s = w['Revenue']
assert w.sheetnames == ['Revenue', 'Notes']
assert w['Notes']['A1'].value == 'Preserve this note'
assert s['B3'].value == 18
kind = '${kind}'
if kind in ('layout', 'blank'):
    assert s['B2'].value == 12
    assert s.column_dimensions['A'].width > 5
    assert s.column_dimensions['B'].width > 5
    source = load_workbook('input.xlsx')['Revenue']
    assert s.page_setup == source.page_setup
    assert s.print_options == source.print_options
    assert s.page_margins == source.page_margins
    assert s.print_area == source.print_area
else:
    assert s['B2'].value == 20
    if kind == 'data':
        assert s['A4'].value == 'Q3' and s['B4'].value == 7
        assert s['A1'].font.bold and s['B1'].font.bold
    else:
        assert s['B4'].value.upper() == '=SUM(B2:B3)'
        assert load_workbook('result.xlsx', data_only=True)['Revenue']['B4'].value == 38
`], { cwd })
        expect(verified.exitCode).toBe(0)
        if (kind === 'blank' || kind === 'formula') {
          fixtureCalls = (await readFile(join(controlRoot, '.fixture/calls.jsonl'), 'utf8')).trim().split('\n')
            .map(line => JSON.parse(line) as { args: string[]; status: number | null })
          if (kind === 'blank') expect(fixtureCalls.some(call => call.args[0] === 'convert')).toBe(false)
          else expect(fixtureCalls.some(call => call.args[0] === 'recalculate' && call.status === 0)).toBe(true)
        }
        const imageBlocks = events.flatMap(event => event.type === 'tool/result'
          ? event.data.message.content.filter(block => block.type === 'image')
          : event.type === 'user/message' && event.data.source.kind === 'ptc-mode'
            ? event.data.content.filter(block => block.type === 'image') : [])
        if (kind === 'layout' && imageBlocks.length === 0) {
          const kit = fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/cli'))
          const previewDir = join(cwd, '.verification-preview')
          await execa(process.execPath, [kit, 'render', '--input', join(cwd, 'result.xlsx'),
            '--output-dir', previewDir, '--sheet', 'Revenue', '--range', 'A1:B3'], { cwd })
          const pngs = (await readdir(previewDir, { recursive: true })).filter(path => path.endsWith('.png'))
          expect(pngs.length).toBeGreaterThan(0)
          for (const path of pngs) {
            const pixels = await execa(python!, ['-c', previewPixels], { input: await readFile(join(previewDir, path)) })
            previewHasContent ||= pixels.stdout === 'content'
          }
        }
        for (const block of imageBlocks) {
          const stored = await readImageFile(join(imageRoot, 'attachments/v1'), block.attachment)
          const pixels = await execa(python!, ['-c', previewPixels], { input: Buffer.from(stored.data) })
          previewHasContent ||= pixels.stdout === 'content'
        }
      },
    })
    const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data] : event.type === 'tool/ptc-dispatch' ? [{ name: event.data.name, arguments: JSON.stringify(event.data.arguments), callId: event.data.rootCallId }] : [])
    const loaded = calls.filter(call => call.name === 'skill').map(call => (JSON.parse(call.arguments) as { name: string }).name)
    const commands = calls.filter(call => call.name === 'bash' || call.name === 'pwsh')
      .map(call => (JSON.parse(call.arguments) as { command: string }).command).join('\n')
    const answer = events.findLast(event => event.type === 'assistant/message')
    const diagnostic = JSON.stringify({ loadedSkills: loaded,
      commands: calls.filter(call => call.name === 'bash' || call.name === 'pwsh')
        .map(call => (JSON.parse(call.arguments) as { command: string }).command.slice(0, 600)),
      answer: answer?.type === 'assistant/message'
        ? answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n').slice(0, 800) : undefined })
    expect(loaded, diagnostic).toContain('office-xlsx')
    expect(calls.some(call => call.name === 'load_workspace_dependencies'), diagnostic).toBe(true)
    if (kind === 'formula') {
      expect(loaded, diagnostic).toContain('office-recalculate')
    }
    if (kind === 'layout' || kind === 'blank') {
      expect(calls.some(call => call.name === 'skill' && call.arguments.includes('office-render'))).toBe(true)
      expect(commands).toMatch(/\srender\b/u)
      expect(commands).toContain('--sheet')
      expect(commands).toContain('--range')
      expect(commands).not.toMatch(/\sconvert\b/u)
      const reads = calls.filter(call => call.name === 'read_image')
      const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
      if (previewHasContent) {
        expect(reads.length).toBeGreaterThan(0)
        const visibleImage = mode === 'native'
          ? results.some(result => !result.isError && reads.some(call => call.callId === result.toolCallId)
            && result.content.some(block => block.type === 'image'))
          : events.some(event => event.type === 'user/message' && event.data.source.kind === 'ptc-mode'
            && event.data.content.some(block => block.type === 'image'))
        expect(visibleImage).toBe(true)
      }
      if (kind === 'blank') expect(previewHasContent).toBe(false)
      if (!previewHasContent) {
        const answer = events.findLast(event => event.type === 'assistant/message')
        if (answer?.type !== 'assistant/message') throw new Error('Agent did not finish with an answer')
        const text = answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        expect(text).toMatch(/(?:content|structure)[^.!?]{0,100}pass/iu)
        expect(text).toMatch(/visual (?:inspection|check)[^.!?]{0,100}(?:not completed|incomplete|could not be completed|unverified)/iu)
        expect(text).not.toMatch(/visually (?:verified|validated|confirmed)|visual (?:check|inspection) (?:passed|successful)/iu)
        expect(reads.length).toBeLessThanOrEqual(1)
        if (kind === 'blank') {
          const firstBlank = fixtureCalls.findIndex(call => call.args[0] === 'render' && call.status === 0)
          expect(firstBlank, JSON.stringify(fixtureCalls)).toBeGreaterThanOrEqual(0)
          expect(fixtureCalls.slice(firstBlank + 1).filter(call => call.args[0] === 'render'), JSON.stringify(fixtureCalls)).toEqual([])
        }
      }
    } else {
      expectNoRenderContext(events)
      expect(calls.some(call => call.name === 'read_image')).toBe(false)
      expect(calls.some(call => call.name === 'skill' && call.arguments.includes('office-render'))).toBe(false)
      expect(commands).not.toMatch(/(?<![\w/.-])(?:render|convert)(?![\w/.-])|\.pdf\b|\.png\b/iu)
      const answer = events.findLast(event => event.type === 'assistant/message')
      if (answer?.type !== 'assistant/message') throw new Error('Agent did not finish with an answer')
      const text = answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      expect(text).not.toMatch(/(?:visual|layout).{0,60}(?:not|skip|omit)|(?:not|skip|omit).{0,60}(?:visual|render)/iu)
    }
  })
})
