/** Register real Office authoring visual-intent e2e cases for the selected document formats. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { officeModelPatches } from './real-office.ts'
import { renderCliFixture } from './render-cli.ts'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const assetRoot = fileURLToPath(new URL('../../assets/', import.meta.url))
const runtime = process.env.DSH_PRIMARY_RUNTIME
const python = runtime && join(runtime, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')

type DocumentFormat = 'docx' | 'pptx' | 'xlsx'

const formats = [
  {
    contentTask: 'change the title text on slide 1 to Quarterly results without changing its formatting',
    verifyContent: "from pptx import Presentation\np=Presentation('result.pptx'); assert len(p.slides) == 1; assert p.slides[0].shapes[0].text == 'Quarterly results'",
    format: 'pptx', task: 'center the title on slide 1 and set its font color to #1F4E79',
    seed: "from pptx import Presentation\nfrom pptx.util import Inches\np=Presentation(); s=p.slides.add_slide(p.slide_layouts[6]); s.shapes.add_textbox(Inches(1),Inches(1),Inches(6),Inches(1)).text='Quarterly revenue'; p.save('input.pptx')",
    verify: "from pptx import Presentation\nfrom pptx.enum.text import PP_ALIGN\np=Presentation('result.pptx'); title=p.slides[0].shapes[0]; r=title.text_frame.paragraphs[0]; assert r.alignment == PP_ALIGN.CENTER; assert abs(2*title.left+title.width-p.slide_width) <= 1; assert str(r.runs[0].font.color.rgb).upper() == '1F4E79'",
  },
  {
    contentTask: 'change the title paragraph text to Quarterly results without changing its formatting',
    verifyContent: "from docx import Document\nd=Document('result.docx'); assert [p.text for p in d.paragraphs] == ['Quarterly results', 'Q1: 12; Q2: 18']",
    format: 'docx', task: 'center the title paragraph and set its font color to #1F4E79',
    seed: "from docx import Document\nd=Document(); d.add_paragraph('Quarterly revenue'); d.add_paragraph('Q1: 12; Q2: 18'); d.save('input.docx')",
    verify: "from docx import Document\nfrom docx.enum.text import WD_ALIGN_PARAGRAPH\nd=Document('result.docx'); p=d.paragraphs[0]; assert p.alignment == WD_ALIGN_PARAGRAPH.CENTER; assert p.runs[0].font.color.rgb == (31,78,121)",
  },
  {
    contentTask: 'change Revenue!B2 to 20 without changing the cell formatting or other data',
    verifyContent: "from openpyxl import load_workbook\nw=load_workbook('result.xlsx'); s=w['Revenue']; assert list(s.values) == [('Quarter','Revenue'),('Q1',20),('Q2',18)]",
    format: 'xlsx', task: 'center the text in Revenue!A1:B1 and set the cells\' fill color to #1F4E79',
    seed: "from openpyxl import Workbook\nw=Workbook(); s=w.active; s.title='Revenue'; s.append(['Quarter','Revenue']); s.append(['Q1',12]); s.append(['Q2',18]); w.save('input.xlsx')",
    verify: "from openpyxl import load_workbook\nw=load_workbook('result.xlsx'); s=w['Revenue']; assert all(s[c].alignment.horizontal == 'center' and s[c].fill.fgColor.rgb.endswith('1F4E79') for c in ('A1','B1')); assert s['B2'].value == 12 and s['B3'].value == 18",
  },
] as const

const intents = [
  { intent: 'explicit', suffix: 'Render the finished file and visually inspect the changed page or sheet.' },
  { intent: 'excluded', suffix: 'Do not render or visually inspect the finished file.' },
  { intent: 'implicit', suffix: '' },
] as const

function within(parent: string, path: string): boolean {
  const part = relative(parent, path)
  return part === '' || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)
}

/**
 * Register the visual-intent e2e cases for the selected document formats.
 * @param selected - Document formats whose cases this spec file registers.
 * @param options - `blank` also registers the pptx case whose preview fixture produces blank pixels.
 */
export function registerVisualIntentCases(selected: readonly DocumentFormat[], options: { blank?: boolean } = {}): void {
  const cases = [
    ...formats.filter(format => selected.includes(format.format)).flatMap(format => intents.flatMap(intent => [
      { ...format, ...intent, kind: 'format' },
      { ...format, ...intent, kind: 'content', task: format.contentTask, verify: format.verifyContent },
    ])),
    ...options.blank === true ? [{ ...formats[0], kind: 'format', intent: 'blank', suffix: intents[0].suffix }] : [],
  ]

  it.skipIf(!process.env.DEEPSEEK_API_KEY || !runtime).each(cases)('$format $kind $intent visual intent', async ({ format, kind, task, seed, verify, intent, suffix }) => {
    const controlRoot = await mkdtemp(join(tmpdir(), 'dsh-office-control-test-'))
    try {
      const previewRoot = join(controlRoot, 'tmp')
      await mkdir(previewRoot)
      const configPath = join(controlRoot, 'office.patch.json')
      const sessionRoot = join(controlRoot, 'sessions')
      // The model can remove its entire preview directory during cleanup.
      const callLogPath = join(controlRoot, 'cli-calls.jsonl')
      await runLoaderSmoke({
        label: `Office ${format} ${kind} ${intent} visual intent`, tempDirPrefix: `dsh-office-${format}-${kind}-${intent}-`,
        binScript: join(repo, 'apps/cli/src/bin.ts'), sourceImport: 'tsx/esm', tsconfigPath: join(repo, 'tsconfig.base.json'),
        configPath, processTimeoutMs: 110_000,
        binArgs: ['--profile', 'headless', '--patch', configPath,
          `In input.${format}, ${task}; save result.${format}. ${suffix} Respond briefly in English.`],
        // The CLI fixture and its log live outside the workspace; bwrap's private /tmp hides both.
        env: { DSH_PRIMARY_RUNTIME: runtime, DSH_PERMISSION_MODE: 'danger-full-access',
          DSH_HOME: join(controlRoot, 'home'), DSH_AGENTS_HOME: join(controlRoot, 'agents'),
          DSH_TELEMETRY_DISABLED: '1',
          TMPDIR: previewRoot, TMP: previewRoot, TEMP: previewRoot,
          HTTP_PROXY: process.env.DSH_OFFICE_TEST_PROXY, HTTPS_PROXY: process.env.DSH_OFFICE_TEST_PROXY },
        async prepare(cwd) {
          await execa(python!, ['-c', seed], { cwd })
          const fixture = await renderCliFixture(controlRoot, python!, intent === 'blank', callLogPath)
          const testAssetRoot = process.env.DSH_OFFICE_TEST_ASSET_ROOT ?? assetRoot
          await writeFile(configPath, JSON.stringify([
            { insert: [{ id: 'skill-office', name: '@deepseek-ai/dsh-skill-office', config: { assetRoot: testAssetRoot, node: process.execPath, cli: fixture.cli } }] },
            { insert: [{ id: 'workspace-dependencies', name: '@deepseek-ai/dsh-tool-workspace-dependencies', config: { source: runtime! } }] },
            ...officeModelPatches(),
            { id: 'session-persistence-jsonl', config: { root: sessionRoot, compression: 'none' } },
          ]))
        },
        async inspect(cwd) {
          const logs = await readdir(sessionRoot, { recursive: true })
          const log = logs.find(path => path.endsWith('session.v4.jsonl'))
          expect(log, `No recorded session for ${format} ${intent} in ${sessionRoot}`).toBeDefined()
          const bytes = await readFile(join(sessionRoot, log!))
          const traceDir = process.env.DSH_OFFICE_TRACE_DIR
          if (traceDir !== undefined) {
            await mkdir(traceDir, { recursive: true })
            await writeFile(join(traceDir, `${format}-${kind}-${intent}.jsonl`), bytes)
          }
          const events = parseSessionLog(bytes.toString('utf8'))
          const calls = events.filter(event => event.type === 'tool/call').map(event => event.data)
          const loaded = calls.filter(call => call.name === 'skill').map(call => (JSON.parse(call.arguments) as { name: string }).name)
          const imageReads = calls.filter(call => call.name === 'read_image')
          const shellCommands = calls.filter(call => call.name === 'bash' || call.name === 'pwsh')
            .map(call => (JSON.parse(call.arguments) as { command: string }).command)
          const answer = events.findLast(event => event.type === 'assistant/message')
          const text = answer?.type === 'assistant/message'
            ? answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : undefined
          const callLog = await readFile(callLogPath, 'utf8').catch((error: unknown) => {
            if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return ''
            throw error
          })
          const renderCalls = callLog.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { args: string[]; status: number | null; pixelsBlank: boolean | null })
            .filter(call => call.args[0] === 'render')
          const diagnostic = JSON.stringify({
            scenario: `${format} ${kind} ${intent}`, loadedSkills: loaded,
            shellCommands: shellCommands.map(command => command.slice(0, 600)),
            renderCalls, imageReads: imageReads.length,
            answer: text?.slice(0, 800) ?? '(missing)',
          }, null, 2)
          if (text === undefined) throw new Error(`Agent did not finish with an answer: ${diagnostic}`)
          const checked = await execa(python!, ['-c', verify], { cwd, reject: false })
          expect(checked.exitCode, `${checked.stderr}\n${diagnostic}`).toBe(0)
          expect(loaded, diagnostic).toContain(`office-${format}`)
          if (intent === 'excluded' || kind === 'content' && intent !== 'explicit') {
            expect(loaded, diagnostic).not.toContain('office-render')
            expect(renderCalls, diagnostic).toEqual([])
            expect(imageReads, diagnostic).toEqual([])
          } else {
            expect(loaded, diagnostic).toContain('office-render')
            expect(renderCalls, diagnostic).toHaveLength(1)
            expect(imageReads.length, diagnostic).toBeLessThanOrEqual(1)
            for (const call of renderCalls) {
              const output = call.args[call.args.indexOf('--output-dir') + 1]
              expect(output, diagnostic).toBeDefined()
              expect(within(cwd, resolve(cwd, output!)), diagnostic).toBe(true)
              expect(call.status, diagnostic).toBe(0)
            }
            if (renderCalls[0]?.pixelsBlank || imageReads.length === 0) {
              expect(text.match(/Content and structure checks passed; visual inspection was not completed\./gu), diagnostic).toHaveLength(1)
              expect(text, diagnostic).not.toMatch(/all checks passed|visually (?:verified|validated|confirmed)/iu)
            }
          }
        },
      })
    } finally {
      await rm(controlRoot, { recursive: true, force: true })
    }
  })
}
