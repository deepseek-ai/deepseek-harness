/** Real-agent Excel validation through the shipped headless profile; requires a built primary runtime. */
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { describe, expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { readImageFile } from '@deepseek-ai/dsh-attachment-local'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
// DSH_PRIMARY_RUNTIME names the same runtime.json + dependencies/ payload used by shipped deployments.
const runtime = process.env.DSH_PRIMARY_RUNTIME
const python = runtime && join(runtime, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')
const model = process.env.MODEL_NAME ?? 'deepseek-flash'
// Development gateways can expose Chat Completions without the official Messages API.
const completions = process.env.DSH_OFFICE_TEST_API === 'openai-completions'

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
    task: 'Fix the cramped layout of Revenue!A1:B3: make the column headers fully readable and the amounts easy to read. Adjust column widths and header styling.',
    kind: 'layout',
  },
  {
    name: 'blank previews end visual checking without changing print settings',
    task: 'Fix the cramped layout of Revenue!A1:B3: make the column headers fully readable and the amounts easy to read. Adjust column widths and header styling.',
    kind: 'blank',
  },
] as const

describe.skipIf(!process.env.DEEPSEEK_API_KEY || !runtime)('Excel validation scope', () => {
  it.each(cases)('$name', async ({ task, kind }) => {
    let events: SessionEvent[] = []
    let original: Buffer | undefined
    let previewHasContent = false
    let fixtureCalls: { args: string[]; status: number | null }[] = []
    await runLoaderSmoke({
      label: `Excel ${kind} validation`,
      tempDirPrefix: 'dsh-xlsx-validation-',
      binScript: join(repo, 'apps/cli/src/bin.ts'),
      sourceImport: 'tsx/esm',
      tsconfigPath: join(repo, 'tsconfig.base.json'),
      configPath: 'office.patch.json',
      binArgs: ['--profile', 'headless', '--patch', 'office.patch.json',
        `${task} Use input.xlsx and save the finished workbook as result.xlsx. Preserve the Notes sheet and leave input.xlsx unchanged. Respond briefly in English.`,
      ],
      processTimeoutMs: 110_000,
      env: {
        DSH_PRIMARY_RUNTIME: runtime,
        DSH_PERMISSION_MODE: 'danger-full-access',
        DSH_TELEMETRY_DISABLED: '1',
        DSH_TOOLS_MODE: 'native',
      },
      async prepare(cwd) {
        await execa(python!, ['-c', seed, kind], { cwd })
        original = await readFile(join(cwd, 'input.xlsx'))
        const fixtureCli = join(cwd, '.fixture', 'cli.js')
        if (kind === 'blank') {
          await mkdir(dirname(fixtureCli))
          const kit = join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))), 'lib/cli.js')
          await writeFile(fixtureCli, `
const { spawnSync } = require('node:child_process');
const { appendFileSync } = require('node:fs');
const { join } = require('node:path');
const args = process.argv.slice(2);
const result = spawnSync(process.execPath, [${JSON.stringify(kit)}, ...args], { encoding: 'utf8' });
if (result.status === 0 && args[0] === 'render') {
  const blank = spawnSync(${JSON.stringify(python)}, ['-c', ${JSON.stringify("from pathlib import Path\nfrom PIL import Image\nimport sys\nfor p in Path(sys.argv[1]).rglob('*.png'):\n    with Image.open(p) as im: size = im.size\n    Image.new('RGBA', size, (0, 0, 0, 0)).save(p)")}, args[args.indexOf('--output-dir') + 1]], { encoding: 'utf8' });
  if (blank.status !== 0) throw new Error(blank.stderr);
}
if (result.status === 0 && args[0] === 'capabilities') {
  const capabilities = JSON.parse(result.stdout);
  capabilities.runtime.cliPath = __filename;
  result.stdout = JSON.stringify(capabilities);
}
appendFileSync(join(__dirname, 'calls.jsonl'), JSON.stringify({ args, status: result.status }) + '\\n');
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
process.exitCode = result.status ?? 1;
`)
        }
        await writeFile(join(cwd, 'office.patch.json'), JSON.stringify([
          { insert: [
            { id: 'office-validation', name: '@deepseek-ai/dsh-skill-office', ...kind === 'blank' ? { config: { cli: fixtureCli } } : {} },
            { id: 'office-dependencies', name: '@deepseek-ai/dsh-tool-workspace-dependencies', config: { source: runtime } },
          ] },
          ...completions ? [
            { id: 'llm-deepseek', disabled: true },
            { id: 'llm-pi-ai', config: { providers: { 'office-test': {
              api: 'openai-completions', apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: process.env.DEEPSEEK_BASE_URL,
              compat: { thinkingFormat: 'deepseek' },
              models: [{ id: model, contextWindow: 128000, maxTokens: 8192, input: ['text', 'image'] }],
            } } } },
          ] : [{ id: 'llm-deepseek', config: { thinking: 'enabled', reasoningEffort: 'high', maxTokens: 8192,
            models: [{ id: model, contextWindow: 128000, maxTokens: 8192, inputModalities: ['text', 'image'] }],
          } }],
          { id: 'agent-default-model', config: { provider: completions ? 'office-test' : 'deepseek-official', model } },
          { id: 'attachment-local', config: { dshHome: join(cwd, '.image-store') } },
          { id: 'session-persistence-jsonl', config: { root: join(cwd, '.sessions'), compression: 'none' } },
        ]))
      },
      async inspect(cwd) {
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
        const paths = await readdir(join(cwd, '.sessions'), { recursive: true })
        const logs = paths.filter(path => /session\.v\d+\.jsonl$/u.test(path))
        expect(logs).toHaveLength(1)
        events = parseSessionLog(await readFile(join(cwd, '.sessions', logs[0]!), 'utf8'))
        if (kind === 'blank') {
          fixtureCalls = (await readFile(join(cwd, '.fixture/calls.jsonl'), 'utf8')).trim().split('\n')
            .map(line => JSON.parse(line) as { args: string[]; status: number | null })
          expect(fixtureCalls.some(call => call.args[0] === 'convert')).toBe(false)
        }
        const imageBlocks = events.flatMap(event => event.type === 'tool/result'
          ? event.data.message.content.filter(block => block.type === 'image') : [])
        if (kind === 'layout' && imageBlocks.length === 0) {
          const kit = join(dirname(fileURLToPath(import.meta.resolve('@deepseek-ai/libreoffice-kit/package.json'))), 'lib/cli.js')
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
          const stored = await readImageFile(join(cwd, '.image-store/attachments/v1'), block.attachment)
          const pixels = await execa(python!, ['-c', previewPixels], { input: Buffer.from(stored.data) })
          previewHasContent ||= pixels.stdout === 'content'
        }
      },
    })
    const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data] : [])
    expect(calls.some(call => call.name === 'skill' && call.arguments.includes('office-xlsx'))).toBe(true)
    expect(calls.some(call => call.name === 'load_workspace_dependencies')).toBe(true)
    const commands = calls.filter(call => call.name === 'bash' || call.name === 'pwsh')
      .map(call => (JSON.parse(call.arguments) as { command: string }).command).join('\n')
    expect(commands).toContain('check_office.py')
    expect(commands).not.toMatch(/\b(?:which|whereis|command -v)[^\n;]*\b(?:libreoffice|soffice)\b/iu)
    expect(commands).not.toMatch(/\bfind[^\n;]*-(?:i?name|path)\s+["']?[*?]*(?:libreoffice|soffice)\b/iu)
    if (kind === 'formula') expect(commands).toMatch(/cli\.js[\s\S]*recalculate/u)
    if (kind === 'layout' || kind === 'blank') {
      expect(commands).toMatch(/cli\.js[\s\S]*render/u)
      expect(commands).toContain('--sheet')
      expect(commands).toContain('--range')
      expect(commands).not.toMatch(/cli\.js["']?\s+convert\b/u)
      const reads = calls.filter(call => call.name === 'read_image')
      const results = events.flatMap(event => event.type === 'tool/result' ? [event.data.message] : [])
      if (previewHasContent) expect(results.some(result => !result.isError && reads.some(call => call.callId === result.toolCallId)
        && result.content.some(block => block.type === 'image'))).toBe(true)
      if (kind === 'blank') expect(previewHasContent).toBe(false)
      if (!previewHasContent) {
        const answer = events.findLast(event => event.type === 'assistant/message')
        if (answer?.type !== 'assistant/message') throw new Error('Agent did not finish with an answer')
        const text = answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
        expect(text).toMatch(/blank|transparent|unavailable|could not|couldn't|unable|failed/iu)
        expect(text).not.toMatch(/visually (?:verified|validated|confirmed)|visual (?:check|inspection) (?:passed|successful)/iu)
        expect(reads.length).toBeLessThanOrEqual(1)
        if (kind === 'blank') {
          const firstBlank = fixtureCalls.findIndex(call => call.args[0] === 'render' && call.status === 0)
          expect(firstBlank, JSON.stringify(fixtureCalls)).toBeGreaterThanOrEqual(0)
          expect(fixtureCalls.slice(firstBlank + 1).filter(call => call.args[0] === 'render'), JSON.stringify(fixtureCalls)).toEqual([])
        }
      }
    } else {
      expect(calls.some(call => call.name === 'read_image' || call.name === 'render_document')).toBe(false)
      expect(commands).not.toMatch(/\b(?:render|convert)\b|\.pdf\b|\.png\b/iu)
      const answer = events.findLast(event => event.type === 'assistant/message')
      if (answer?.type !== 'assistant/message') throw new Error('Agent did not finish with an answer')
      const text = answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('')
      expect(text).not.toMatch(/(?:visual|layout).{0,60}(?:not|skip|omit)|(?:not|skip|omit).{0,60}(?:visual|render)/iu)
    }
  })
})
