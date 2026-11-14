/** Real Word content edits preserve formatting without package-wide investigation. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type {} from '@deepseek-ai/dsh-tool-executor-ptc/types'
import { expectNoRenderContext, officeModelPatches } from './fixtures/real-office.ts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const runtime = process.env.DSH_PRIMARY_RUNTIME
const python = runtime && join(runtime, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')

it.skipIf(!process.env.DEEPSEEK_API_KEY || !runtime).each(['native', 'ptc'])('checks a Word content edit without package-wide investigation (%s)', async (mode) => {
  await runLoaderSmoke({
    label: 'Word content validation', tempDirPrefix: 'dsh-docx-validation-',
    binScript: join(repo, 'apps/cli/src/bin.ts'), sourceImport: 'tsx/esm', tsconfigPath: join(repo, 'tsconfig.base.json'),
    configPath: 'office.patch.json', processTimeoutMs: 110_000,
    binArgs: ['--profile', 'headless', '--patch', 'office.patch.json',
      ...mode === 'ptc' ? ['--patch', join(repo, 'apps/cli/config/examples/ptc.yml')] : [],
      'In input.docx, change the title paragraph text to Quarterly results without changing its formatting; save result.docx. Do not render or visually inspect the finished file. Respond briefly in English.'],
    env: { DSH_PRIMARY_RUNTIME: runtime, DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1',
      HTTP_PROXY: process.env.DSH_OFFICE_TEST_PROXY, HTTPS_PROXY: process.env.DSH_OFFICE_TEST_PROXY },
    async prepare(cwd) {
      await execa(python!, ['-c', `
from docx import Document
from docx.shared import Pt, RGBColor
d = Document()
r = d.add_paragraph('Quarterly revenue').runs[0]
r.bold = True
r.font.size = Pt(24)
r.font.color.rgb = RGBColor(31, 78, 121)
d.add_paragraph('Q1: 12; Q2: 18')
d.save('input.docx')
`], { cwd })
      await writeFile(join(cwd, 'office.patch.json'), JSON.stringify([
        { insert: [{ id: 'skill-office', name: '@deepseek-ai/dsh-skill-office', config: { assetRoot: join(repo, 'packages/skill/skill-office/assets') } }] },
        { insert: [{ id: 'workspace-dependencies', name: '@deepseek-ai/dsh-tool-workspace-dependencies', config: { source: runtime! } }] },
        ...officeModelPatches(),
        { id: 'session-persistence-jsonl', config: { root: join(cwd, '.sessions'), compression: 'none' } },
      ]))
    },
    async inspect(cwd) {
      await execa(python!, ['-c', `
from docx import Document
d = Document('result.docx')
assert [p.text for p in d.paragraphs] == ['Quarterly results', 'Q1: 12; Q2: 18']
r = d.paragraphs[0].runs[0]
assert r.bold and r.font.size.pt == 24 and r.font.color.rgb == (31, 78, 121)
assert Document('input.docx').paragraphs[0].text == 'Quarterly revenue'
`], { cwd })
      const paths = await readdir(join(cwd, '.sessions'), { recursive: true })
      const log = paths.find(path => path.endsWith('session.v4.jsonl'))
      expect(log).toBeDefined()
      const events = parseSessionLog(await readFile(join(cwd, '.sessions', log!), 'utf8'))
      expectNoRenderContext(events)
      const calls = events.flatMap((event) => {
        if (event.type === 'tool/call') return [event.data]
        if (event.type === 'tool/ptc-dispatch') return [{ name: event.data.name, arguments: JSON.stringify(event.data.arguments) }]
        return []
      })
      const programs = JSON.stringify(calls)
      expect(programs).not.toMatch(/(?<![\w.-])(?:inspect|docx|zipfile)\.py\b/u)
      expect(programs).not.toMatch(
        /\bunzip\b|\bextractall\s*\(|\bnamelist\s*\(|\bcore_properties\b|docProps\/|word\/(?:document|styles)\.xml/u,
      )
    },
  })
})
