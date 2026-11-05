/** Register real Office authoring visual-intent e2e cases for the selected document formats. */
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { officeCalls, officeModelPatches, officeToolPatches } from './real-office.ts'

const repo = fileURLToPath(new URL('../../../../../', import.meta.url))
const assetRoot = fileURLToPath(new URL('../../assets/', import.meta.url))
const runtime = process.env.DSH_PRIMARY_RUNTIME
const python = runtime && join(runtime, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')

type DocumentFormat = 'docx' | 'pptx' | 'xlsx'

const formats = [
  {
    contentTask: 'change the title text on slide 1 to Quarterly results without changing its formatting',
    verifyContent: "from pptx import Presentation\np=Presentation('result.pptx'); assert len(p.slides) == 1; assert p.slides[0].shapes[0].text == 'Quarterly results'",
    contentRenders: true,
    notesTask: 'set the speaker notes of slide 1 to Revenue grew 50%. without changing the slide',
    verifyNotes: "from pptx import Presentation\np=Presentation('result.pptx'); s=p.slides[0]; assert s.has_notes_slide and s.notes_slide.notes_text_frame.text.strip() == 'Revenue grew 50%.'; assert s.shapes[0].text == 'Quarterly revenue'",
    format: 'pptx', task: 'center the title on slide 1 and set its font color to #1F4E79',
    seed: "from pptx import Presentation\nfrom pptx.util import Inches\np=Presentation(); s=p.slides.add_slide(p.slide_layouts[6]); s.shapes.add_textbox(Inches(1),Inches(1),Inches(6),Inches(1)).text='Quarterly revenue'; p.save('input.pptx')",
    verify: "from pptx import Presentation\nfrom pptx.enum.text import PP_ALIGN\np=Presentation('result.pptx'); title=p.slides[0].shapes[0]; r=title.text_frame.paragraphs[0]; assert r.alignment == PP_ALIGN.CENTER; assert abs(2*title.left+title.width-p.slide_width) <= 1; assert str(r.runs[0].font.color.rgb).upper() == '1F4E79'",
  },
  {
    contentTask: 'change the title paragraph text to Quarterly results without changing its formatting',
    verifyContent: "from docx import Document\nd=Document('result.docx'); assert [p.text for p in d.paragraphs] == ['Quarterly results', 'Q1: 12; Q2: 18']",
    contentRenders: false,
    format: 'docx', task: 'center the title paragraph and set its font color to #1F4E79',
    seed: "from docx import Document\nd=Document(); d.add_paragraph('Quarterly revenue'); d.add_paragraph('Q1: 12; Q2: 18'); d.save('input.docx')",
    verify: "from docx import Document\nfrom docx.enum.text import WD_ALIGN_PARAGRAPH\nd=Document('result.docx'); p=d.paragraphs[0]; assert p.alignment == WD_ALIGN_PARAGRAPH.CENTER; assert p.runs[0].font.color.rgb == (31,78,121)",
  },
  {
    contentTask: 'change Revenue!B2 to 20 without changing the cell formatting or other data',
    verifyContent: "from openpyxl import load_workbook\nw=load_workbook('result.xlsx'); s=w['Revenue']; assert list(s.values) == [('Quarter','Revenue'),('Q1',20),('Q2',18)]",
    contentRenders: false,
    format: 'xlsx', task: 'center the text in Revenue!A1:B1 and set the cells\' fill color to #1F4E79',
    seed: "from openpyxl import Workbook\nw=Workbook(); s=w.active; s.title='Revenue'; s.append(['Quarter','Revenue']); s.append(['Q1',12]); s.append(['Q2',18]); w.save('input.xlsx')",
    verify: "from openpyxl import load_workbook\nw=load_workbook('result.xlsx'); s=w['Revenue']; assert all(s[c].alignment.horizontal == 'center' and s[c].fill.fgColor.rgb.endswith('1F4E79') for c in ('A1','B1')); assert s['B2'].value == 12 and s['B3'].value == 18",
  },
] as const

const explicitIntent = { intent: 'explicit', suffix: 'Render the finished file and visually inspect the changed page or sheet.' } as const
const excludedIntent = { intent: 'excluded', suffix: 'Do not render or visually inspect the finished file.' } as const
const implicitIntent = { intent: 'implicit', suffix: '' } as const
const intents = [explicitIntent, excludedIntent, implicitIntent]

/**
 * Register the visual-intent e2e cases for the selected document formats. Without an explicit request, appearance
 * edits render once, content edits render once only where the format's library cannot check their layout (PPTX
 * fixed-size text boxes), and PPTX speaker-notes edits never render.
 * @param selected - Document formats whose cases this spec file registers.
 */
export function registerVisualIntentCases(selected: readonly DocumentFormat[]): void {
  const cases = formats.filter(format => selected.includes(format.format)).flatMap(format => [
    ...intents.flatMap(intent => [
      { ...format, ...intent, kind: 'format', rendersUnrequested: true },
      { ...format, ...intent, kind: 'content', task: format.contentTask, verify: format.verifyContent, rendersUnrequested: format.contentRenders },
    ]),
    ...'notesTask' in format
      ? [{ ...format, ...implicitIntent, kind: 'notes', task: format.notesTask, verify: format.verifyNotes, rendersUnrequested: false }]
      : [],
  ])

  it.skipIf(!process.env.DEEPSEEK_API_KEY || !runtime).each(cases)('$format $kind $intent visual intent', async ({ format, kind, task, seed, verify, intent, suffix, rendersUnrequested }) => {
    const controlRoot = await mkdtemp(join(tmpdir(), 'dsh-office-control-test-'))
    try {
      const previewRoot = join(controlRoot, 'tmp')
      await mkdir(previewRoot)
      const configPath = join(controlRoot, 'office.patch.json')
      const sessionRoot = join(controlRoot, 'sessions')
      await runLoaderSmoke({
        label: `Office ${format} ${kind} ${intent} visual intent`, tempDirPrefix: `dsh-office-${format}-${kind}-${intent}-`,
        binScript: join(repo, 'apps/cli/src/bin.ts'), sourceImport: 'tsx/esm', tsconfigPath: join(repo, 'tsconfig.base.json'),
        configPath, processTimeoutMs: 110_000,
        binArgs: ['--profile', 'headless', '--patch', configPath,
          `In input.${format}, ${task}; save result.${format}. ${suffix} Respond briefly in English.`],
        env: { DSH_PRIMARY_RUNTIME: runtime, DSH_PERMISSION_MODE: 'danger-full-access',
          DSH_HOME: join(controlRoot, 'home'), DSH_AGENTS_HOME: join(controlRoot, 'agents'),
          DSH_TELEMETRY_DISABLED: '1',
          TMPDIR: previewRoot, TMP: previewRoot, TEMP: previewRoot,
          HTTP_PROXY: process.env.DSH_OFFICE_TEST_PROXY, HTTPS_PROXY: process.env.DSH_OFFICE_TEST_PROXY },
        async prepare(cwd) {
          await execa(python!, ['-c', seed], { cwd })
          const testAssetRoot = process.env.DSH_OFFICE_TEST_ASSET_ROOT ?? assetRoot
          await writeFile(configPath, JSON.stringify([
            { insert: [{ id: 'skill-office', name: '@deepseek-ai/dsh-skill-office', config: { assetRoot: testAssetRoot } }] },
            ...officeToolPatches(),
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
          const renderCalls = officeCalls(events).filter(call => call.name === 'office_render')
          const rendered = events.filter(event => event.type === 'tool/result' && renderCalls.some(call => call.callId === event.data.message.toolCallId)
            && !event.data.message.isError && event.data.message.content.some(block => block.type === 'image')).length
          const shellCommands = calls.filter(call => call.name === 'bash' || call.name === 'pwsh')
            .map(call => (JSON.parse(call.arguments) as { command: string }).command)
          const answer = events.findLast(event => event.type === 'assistant/message')
          const text = answer?.type === 'assistant/message'
            ? answer.data.message.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') : undefined
          const diagnostic = JSON.stringify({
            scenario: `${format} ${kind} ${intent}`, loadedSkills: loaded,
            shellCommands: shellCommands.map(command => command.slice(0, 600)),
            renderCalls, renderedImages: rendered,
            answer: text?.slice(0, 800) ?? '(missing)',
          }, null, 2)
          if (text === undefined) throw new Error(`Agent did not finish with an answer: ${diagnostic}`)
          const checked = await execa(python!, ['-c', verify], { cwd, reject: false })
          expect(checked.exitCode, `${checked.stderr}\n${diagnostic}`).toBe(0)
          expect(loaded, diagnostic).toContain(`office-${format}`)
          if (intent === 'excluded' || intent === 'implicit' && !rendersUnrequested) {
            expect(renderCalls, diagnostic).toEqual([])
          } else {
            expect(renderCalls, diagnostic).toHaveLength(1)
            if (rendered === 0) {
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
