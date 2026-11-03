// @vitest-environment jsdom
// Office rows dispatch by tool name and retain input navigation and settled output.

import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { contextMenuHook, bindSnapshotSelector, makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { zh, en, ja, es, fr, de, ru, pt } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolTreeProps } from '../src/client/contract/slots.ts'
import { officeRowModel } from '../src/client/tool/models/office-card-model.ts'
import { OfficeRow, OfficeRenderRow, officeToolview, type OfficeRenderRowProps } from '../src/client/tool/toolviews/office-row.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId
const t: ToolTreeProps['t'] = makeTranslate(zh, commonZh)
const RENDER_ARGS = '{"input":"docs/deck.pptx"}'
const image: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), mediaType: 'image/png', bytes: 120, width: 800, height: 600,
}
const SUMMARY = 'Rendered 1 image of /w/app/docs/deck.pptx (3 in the document) at 144 DPI.'

const running = (argsRaw = RENDER_ARGS, name = 'office_render'): StartedToolCall => ({
  phase: 'start', args: PartialArguments.fromText(argsRaw), callId: 'c1', name, argsRaw,
  turn: 1, step: 1, time: 1_000, subCalls: [],
})

const settled = (over: Partial<ToolResultNode> = {}, argsRaw = RENDER_ARGS, name = 'office_render'): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1', name,
  args: PartialArguments.fromText(argsRaw), call: { name, argsRaw }, callTime: 1_000,
  content: [{ type: 'text', text: SUMMARY }, { type: 'text', text: 'Page 2: 800x600 px' }, { type: 'image', attachment: image }],
  isError: false, meta: { path: '/w/app/docs/deck.pptx' }, subCalls: [], ...over,
})

describe('officeRowModel', () => {
  it('derives a render card from the recorded input path and result images', () => {
    expect(officeRowModel('office_render', settled(), '/w/app')).toEqual({
      titleKey: 'tool.title.officeRender', summary: 'docs/deck.pptx', filePath: '/w/app/docs/deck.pptx',
      image: { path: '/w/app/docs/deck.pptx', images: [{ attachment: image }], extraText: `${SUMMARY}\nPage 2: 800x600 px` },
    })
  })

  it('titles each tool and summarizes written outputs without an operation argument', () => {
    const convert = '{"input":"/w/app/deck.pptx","format":"pdf"}'
    expect(officeRowModel('office_convert', running(convert, 'office_convert'), '/w/app')).toEqual({
      titleKey: 'tool.title.officeConvert', summary: 'deck.pptx → pdf', filePath: '/w/app/deck.pptx', image: null,
    })
    expect(officeRowModel('office_recalculate', running('{"input":"book.xlsx"}', 'office_recalculate'))).toMatchObject({
      titleKey: 'tool.title.officeRecalculate', summary: 'book.xlsx', filePath: undefined,
    })
    expect(officeRowModel('other', running('{"input":"unfinished'))).toMatchObject({ titleKey: 'tool.title.generic', summary: '' })
  })

  it.each([
    ['office_render', 'tool.title.officeRender'], ['office_convert', 'tool.title.officeConvert'],
    ['office_recalculate', 'tool.title.officeRecalculate'],
  ])('selects %s from its wire name even when operation metadata conflicts', (name, titleKey) => {
    const block = settled({ meta: { path: '/w/app/docs/deck.pptx', operation: 'convert' } },
      '{"operation":"render","input":"docs/deck.pptx"}', name)
    const model = officeRowModel(name, block)
    expect(model.titleKey).toBe(titleKey)
    expect(model.image !== null).toBe(name === 'office_render')
  })

  it('declines the image card for failures, malformed metadata, unknown blocks, and malformed images', () => {
    expect(officeRowModel('office_render', settled({ isError: true })).image).toBeNull()
    expect(officeRowModel('office_render', settled({ meta: { path: 'relative.pptx' } })).image).toBeNull()
    expect(officeRowModel('office_render', settled({ content: [{ type: 'text', text: SUMMARY }, { type: 'reasoning', text: 'x' } as never] })).image).toBeNull()
    expect(officeRowModel('office_render', settled({ content: [{ type: 'text', text: SUMMARY }] })).image).toBeNull()
    expect(officeRowModel('office_render', settled({ content: [{ type: 'image', attachment: image }] })).image).toEqual({
      path: '/w/app/docs/deck.pptx', images: [{ attachment: image }], extraText: null,
    })
  })
})

describe('OfficeRow', () => {
  const list = () => bindSnapshotSelector(createSnapshotStore<SessionListState>({
    ids: [SID],
    byId: { [SID]: { id: SID, displayTitle: 'r', running: false, retainedBy: {}, blank: false, updatedAt: 0, cwd: '/w/app' } },
    phase: 'ready', projectionsBySession: {},
  }))
  const loadImage: MessageImageLoader = vi.fn(() => Promise.reject(new Error('not used')))
  const props = (block: StartedToolCall | ToolResultNode, renderSlot = vi.fn(() => <div data-images />)): OfficeRenderRowProps => ({
    useDisclosure, callId: 'c1', toolName: block.name,
    ...'kind' in block ? { phase: 'result' as const, block } : { phase: block.phase, block },
    openFile: vi.fn(), renderSlot, loadImage, useContextMenu: contextMenuHook(), resolveFilePath: path => path,
    sessionId: SID, useSessions: list(), cwd: '/w/app', t,
  } as OfficeRenderRowProps)

  it('expands a render to its images through the office image slot', () => {
    const renderSlot = vi.fn(() => <div data-images />)
    const view = render(<OfficeRenderRow {...props(settled(), renderSlot)} />)
    expect(view.container.textContent).toContain('渲染文档')
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(renderSlot).toHaveBeenLastCalledWith('tool.call.office_render.images', { images: [{ attachment: image }], loadImage, align: 'start' })
    expect(view.container.textContent).toContain(SUMMARY)
    expect(view.container.textContent).toContain('Page 2: 800x600 px')
  })

  it('shows a running call without images', () => {
    const renderSlot = vi.fn(() => <div data-images />)
    const view = render(<OfficeRenderRow {...props(running(), renderSlot)} />)
    expect(view.container.textContent).toContain('docs/deck.pptx')
    expect(renderSlot).not.toHaveBeenCalled()
  })

  it.each([
    ['office_convert', 'pdf', '转换文档', 'Converted', ', 3 pages'],
    ['office_recalculate', 'xlsx', '重算工作簿', 'Recalculated', ''],
  ])('keeps the %s result text and output path while its title link opens the input', (name, format, title, verb, pages) => {
    const input = '/w/app/input.xlsx'
    const file = `/tmp/office/output.${format}`
    const output = `${verb} ${input} to ${format} (123 bytes${pages}): ${file}\n`
      + 'Copy this temporary file to its destination with the shell now; it is deleted when this conversation ends.'
    const warning = 'Fonts not installed and substituted: Example font.'
    const block = settled({ meta: { path: input, file }, content: [{ type: 'text', text: output }, { type: 'text', text: warning }] },
      JSON.stringify({ input: 'input.xlsx', format }), name)
    const rowProps = props(block)
    const view = render(<OfficeRow {...rowProps} />)
    expect(view.container.textContent).toContain(title)
    fireEvent.click(view.getByRole('button', { name: `input.xlsx → ${format}` }))
    expect(rowProps.openFile).toHaveBeenCalledWith(input)
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(view.container.textContent).toContain(`${output}\n${warning}`)
    expect(rowProps.renderSlot).not.toHaveBeenCalled()
  })

  it('registers all three wire names, declares images only for render, and removes them on disposal', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const locale = new LocaleRuntime(runtime.ctx)
    locale.register('conversation', { en, zh })
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const fiber = await runtime.mount(officeToolview)
    expect(runtime.slots.entries('tool.call.toolview')).toHaveLength(0)
    await runtime.root.declare({ 'tool.call.toolview': { kind: 'keyed', scope: 'session' } }, () => null)
    expect(runtime.slots.entries('tool.call.toolview').map(entry => [entry.options.key, entry.component])).toEqual([
      ['office_render', OfficeRenderRow], ['office_convert', OfficeRow], ['office_recalculate', OfficeRow],
    ])
    expect(runtime.slots.spec('tool.call.office_render.images')).toEqual({ kind: 'single', scope: 'session' })
    await fiber.dispose()
    expect(runtime.slots.entries('tool.call.toolview')).toHaveLength(0)
    expect(runtime.slots.spec('tool.call.office_render.images')).toBeUndefined()
  })
})

it.each([
  ['zh', zh, ['渲染文档', '转换文档', '重算工作簿']],
  ['en', en, ['Render document', 'Convert document', 'Recalculate workbook']],
  ['ja', ja, ['文書を描画', '文書を変換', 'ブックを再計算']],
  ['es', es, ['Representar documento', 'Convertir documento', 'Recalcular libro']],
  ['fr', fr, ['Afficher le document', 'Convertir le document', 'Recalculer le classeur']],
  ['de', de, ['Dokument rendern', 'Dokument konvertieren', 'Arbeitsmappe neu berechnen']],
  ['ru', ru, ['Отрисовать документ', 'Преобразовать документ', 'Пересчитать книгу']],
  ['pt', pt, ['Renderizar documento', 'Converter documento', 'Recalcular pasta de trabalho']],
] as const)('keeps the %s Office titles on the dedicated keys', (_language, dictionary, titles) => {
  expect([dictionary['tool.title.officeRender'], dictionary['tool.title.officeConvert'], dictionary['tool.title.officeRecalculate']]).toEqual(titles)
})
