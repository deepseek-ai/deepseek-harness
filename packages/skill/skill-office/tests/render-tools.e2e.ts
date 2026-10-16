/** Actual skill discovery and CLI rendering through the shipped headless composition. */
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execa } from 'execa'
import { expect, it } from 'vitest'
import { runLoaderSmoke } from '@deepseek-ai/dsh-loader-smoke'
import { parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import { expectNoRenderContext, officeModelPatches } from './fixtures/real-office.ts'

const repo = fileURLToPath(new URL('../../../../', import.meta.url))
const runtime = process.env.DSH_PRIMARY_RUNTIME
const python = runtime && join(runtime, 'dependencies/python', process.platform === 'win32' ? 'python.exe' : 'bin/python3')

const launch = {
  binScript: join(repo, 'apps/cli/src/bin.ts'), sourceImport: 'tsx/esm' as const, tsconfigPath: join(repo, 'tsconfig.base.json'),
  configPath: 'office.patch.json', processTimeoutMs: 110_000,
  env: { DSH_PRIMARY_RUNTIME: runtime, DSH_PERMISSION_MODE: 'danger-full-access', DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native',
    HTTP_PROXY: process.env.DSH_OFFICE_TEST_PROXY, HTTPS_PROXY: process.env.DSH_OFFICE_TEST_PROXY },
}

async function prepareOffice(cwd: string) {
  await writeFile(join(cwd, 'office.patch.json'), JSON.stringify([
    ...officeModelPatches(),
    { insert: [{ id: 'skill-office', name: '@deepseek-ai/dsh-skill-office', config: { assetRoot: join(repo, 'packages/skill/skill-office/assets') } }] },
    { insert: [{ id: 'workspace-dependencies', name: '@deepseek-ai/dsh-tool-workspace-dependencies', config: { source: runtime! } }] },
    { id: 'session-persistence-jsonl', config: { root: join(cwd, '.sessions'), compression: 'none' } },
  ]))
}

async function sessionEvents(cwd: string) {
  const logs = await readdir(join(cwd, '.sessions'), { recursive: true })
  const path = logs.find(p => p.endsWith('session.v4.jsonl'))
  expect(path).toBeDefined()
  const events = parseSessionLog(await readFile(join(cwd, '.sessions', path!), 'utf8'))
  return events
}

it.skipIf(!process.env.DEEPSEEK_API_KEY || !runtime).each([{ format: 'docx', mode: 'native' }, { format: 'pdf', mode: 'native' }, { format: 'docx', mode: 'ptc' }])('loads the operation skill and renders $format through the shell in $mode mode', async ({ format, mode }) => {
  await runLoaderSmoke({
    label: 'Office CLI rendering', tempDirPrefix: 'dsh-office-render-',
    ...launch, env: { ...launch.env, DSH_TOOLS_MODE: mode },
    binArgs: ['--profile', 'headless', '--patch', 'office.patch.json',
      `Export page 1 of input.${format} as PNG into preview and check that the exported image is readable. Report briefly in English.`],
    async prepare(cwd) {
      await execa(python!, ['-c', "from docx import Document\nd=Document()\nd.add_heading('Quarterly revenue',0)\nd.add_paragraph('Q1: 12; Q2: 18; Total: 30')\nd.save('input.docx')"], { cwd })
      if (format === 'pdf') await execa(python!, ['-c', "from PIL import Image, ImageDraw\nim=Image.new('RGB',(300,200),'white')\nImageDraw.Draw(im).rectangle((30,30,150,100),fill='black')\nim.save('input.pdf','PDF')"], { cwd })
      await prepareOffice(cwd)
    },
    async inspect(cwd) {
      const events = await sessionEvents(cwd)
      const calls = events.flatMap((event) => {
        if (event.type === 'tool/call') return [event.data]
        if (event.type === 'tool/ptc-dispatch') return [{ name: event.data.name, arguments: JSON.stringify(event.data.arguments) }]
        return []
      })
      const skills = calls.filter(call => call.name === 'skill').map(call => JSON.parse(call.arguments) as { name: string })
      expect(skills.some(skill => skill.name === 'office-render'), JSON.stringify(skills)).toBe(true)
      const commands = calls.filter(call => call.name === 'bash' || call.name === 'pwsh').map(call => (JSON.parse(call.arguments) as { command: string }).command).join('\n')
      expect(commands).toMatch(/\srender\b/u)
      expect(commands).toContain('--pages')
      expect(commands).toContain('--output-dir')
      const pixels = await execa(python!, ['-c', "from pathlib import Path\nfrom PIL import Image\nfiles=list(Path('preview').glob('*.png'))\nassert files\nfor f in files:\n im=Image.open(f).convert('RGBA')\n visible=Image.alpha_composite(Image.new('RGBA',im.size,'white'),im).convert('RGB')\n print('content' if any(a!=b for a,b in visible.getextrema()) else 'blank')"], { cwd })
      expect(pixels.exitCode).toBe(0)
      if (format === 'pdf') expect(pixels.stdout.trim()).toBe('content')
      const authoring = calls.findIndex(call => call.name === 'skill' && /office-(docx|pptx|xlsx)/u.test(call.arguments))
      if (pixels.stdout.includes('blank')) {
        if (authoring !== -1) {
          const rendered = calls.findIndex(call => (call.name === 'bash' || call.name === 'pwsh') && /\srender\b/u.test(call.arguments))
          expect(authoring, 'content checks after a blank preview may need the format skill').toBeGreaterThan(rendered)
        }
        const final = events.filter(e => e.type === 'assistant/message').at(-1)?.data.message.content
          .filter(b => b.type === 'text').map(b => b.text).join(' ')
        expect(final).toMatch(/visual (?:inspection|check)[^.!?]{0,100}(?:not completed|incomplete|could not be completed|unverified)/iu)
      } else {
        expect(authoring, JSON.stringify(skills)).toBe(-1)
      }
      expect(calls.some(e => e.name === 'read_image')).toBe(true)
    },
  })
})

it.skipIf(!process.env.DEEPSEEK_API_KEY || !runtime)('keeps Office skills and the renderer unloaded for an ordinary task', async () => {
  await runLoaderSmoke({
    ...launch,
    label: 'ordinary task with Office routing', tempDirPrefix: 'dsh-office-unused-',
    binArgs: ['--profile', 'headless', '--patch', 'office.patch.json', 'What is 17 times 23? Reply with just the integer.'],
    prepare: prepareOffice,
    async inspect(cwd) {
      const events = await sessionEvents(cwd)
      expectNoRenderContext(events)
      const calls = events.filter(event => event.type === 'tool/call')
      expect(calls.filter(event => event.data.name === 'skill')).toEqual([])
      const answer = events.filter(event => event.type === 'assistant/message').at(-1)?.data.message.content
        .filter(block => block.type === 'text').map(block => block.text).join('')
      expect(answer?.trim()).toBe('391')
    },
  })
})

it.skipIf(!process.env.DEEPSEEK_API_KEY || !runtime)('exports PDF through the operation skill and preserves the source', async () => {
  let original: Buffer | undefined
  await runLoaderSmoke({
    ...launch,
    label: 'Office PDF export', tempDirPrefix: 'dsh-office-export-',
    binArgs: ['--profile', 'headless', '--patch', 'office.patch.json',
      'Convert input.docx to result.pdf, preserving input.docx. Do not change the document content. Respond briefly in English.'],
    async prepare(cwd) {
      await execa(python!, ['-c', "from docx import Document\nd=Document()\nd.add_paragraph('Quarterly revenue: 30')\nd.save('input.docx')"], { cwd })
      original = await readFile(join(cwd, 'input.docx'))
      await prepareOffice(cwd)
    },
    async inspect(cwd) {
      const events = await sessionEvents(cwd)
      expectNoRenderContext(events)
      const calls = events.flatMap(event => event.type === 'tool/call' ? [event.data]
        : event.type === 'tool/ptc-dispatch' ? [{ name: event.data.name, arguments: JSON.stringify(event.data.arguments) }] : [])
      const skills = calls.filter(call => call.name === 'skill').map(call => (JSON.parse(call.arguments) as { name: string }).name)
      expect(skills).toContain('office-export-pdf')
      expect(skills).not.toEqual(expect.arrayContaining(['office-render']))
      expect(skills.some(name => ['office-docx', 'office-pptx', 'office-xlsx'].includes(name))).toBe(false)
      const commands = calls.filter(call => call.name === 'bash' || call.name === 'pwsh')
        .map(call => (JSON.parse(call.arguments) as { command: string }).command).join('\n')
      expect(commands).toMatch(/\sconvert\b/u)
      expect(commands).not.toMatch(/\srender\b/u)
      expect(commands).not.toMatch(/pypdf|PyPDF2|\bfitz\b|pdfminer|pdfplumber|pdfinfo|pdftotext/iu)
      expect((await readFile(join(cwd, 'result.pdf'))).subarray(0, 5).toString()).toBe('%PDF-')
      expect(await readFile(join(cwd, 'input.docx'))).toEqual(original)
    },
  })
})
