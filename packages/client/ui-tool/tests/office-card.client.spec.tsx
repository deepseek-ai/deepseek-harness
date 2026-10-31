// @vitest-environment jsdom
// The office row: its pure model over raw arguments, persisted metadata, and result
// content, and the keyed toolview that renders a successful render's images through
// the tool-owned `tool.call.office.images` slot.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { Context } from '@deepseek-ai/cordis'
import { contextMenuHook, bindSnapshotSelector, makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import type { StartedToolCall, ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MessageImageLoader } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import { AttachmentId, type ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ToolTreeProps } from '../src/client/contract/slots.ts'
import { officeRowModel } from '../src/client/tool/models/office-card-model.ts'
import { OfficeRow, officeToolview, type OfficeRowProps } from '../src/client/tool/toolviews/office-row.tsx'

afterEach(cleanup)

const SID = 's1' as SessionId
const t: ToolTreeProps['t'] = makeTranslate(zh, commonZh)
const RENDER_ARGS = '{"operation":"render","input":"docs/deck.pptx"}'
const image: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'b'.repeat(64)}`), mediaType: 'image/png', bytes: 120, width: 800, height: 600,
}
const SUMMARY = 'Rendered 1 image of /w/app/docs/deck.pptx (3 in the document) at 144 DPI.'

const running = (argsRaw = RENDER_ARGS): StartedToolCall => ({
  phase: 'start', args: PartialArguments.fromText(argsRaw), callId: 'c1', name: 'office', argsRaw,
  turn: 1, step: 1, time: 1_000, subCalls: [],
})

const settled = (over: Partial<ToolResultNode> = {}, argsRaw = RENDER_ARGS): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1', name: 'office',
  args: PartialArguments.fromText(argsRaw), call: { name: 'office', argsRaw }, callTime: 1_000,
  content: [{ type: 'text', text: SUMMARY }, { type: 'text', text: 'Page 2: 800x600 px' }, { type: 'image', attachment: image }],
  isError: false, meta: { path: '/w/app/docs/deck.pptx' }, subCalls: [], ...over,
})

describe('officeRowModel', () => {
  it('derives a render card from the recorded input path and result images', () => {
    expect(officeRowModel(settled(), '/w/app')).toEqual({
      titleKey: 'tool.title.renderDocument', summary: 'docs/deck.pptx', filePath: '/w/app/docs/deck.pptx',
      image: { path: '/w/app/docs/deck.pptx', images: [{ attachment: image }], extraText: `${SUMMARY}\nPage 2: 800x600 px` },
    })
  })

  it('titles each operation and summarizes written outputs', () => {
    const convert = '{"operation":"convert","input":"/w/app/deck.pptx","format":"pdf"}'
    expect(officeRowModel(running(convert), '/w/app')).toEqual({
      titleKey: 'tool.title.convertDocument', summary: 'deck.pptx → pdf', filePath: '/w/app/deck.pptx', image: null,
    })
    expect(officeRowModel(running('{"operation":"recalculate","input":"book.xlsx"}'))).toMatchObject({
      titleKey: 'tool.title.recalculateWorkbook', summary: 'book.xlsx', filePath: undefined,
    })
    expect(officeRowModel(running('{"operation":"other"'))).toMatchObject({ titleKey: 'tool.title.generic', summary: '' })
  })

  it('declines the image card for failures, malformed metadata, unknown blocks, and malformed images', () => {
    expect(officeRowModel(settled({ isError: true })).image).toBeNull()
    expect(officeRowModel(settled({ meta: { path: 'relative.pptx' } })).image).toBeNull()
    expect(officeRowModel(settled({ content: [{ type: 'text', text: SUMMARY }, { type: 'reasoning', text: 'x' } as never] })).image).toBeNull()
    expect(officeRowModel(settled({ content: [{ type: 'text', text: SUMMARY }] })).image).toBeNull()
    expect(officeRowModel(settled({ content: [{ type: 'image', attachment: image }] })).image).toEqual({
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
  const props = (block: StartedToolCall | ToolResultNode, renderSlot = vi.fn(() => <div data-images />)): OfficeRowProps => ({
    useDisclosure, callId: 'c1', toolName: 'office',
    ...'kind' in block ? { phase: 'result' as const, block } : { phase: block.phase, block },
    openFile: vi.fn(), renderSlot, loadImage, useContextMenu: contextMenuHook(), resolveFilePath: path => path,
    sessionId: SID, useSessions: list(), cwd: '/w/app', t,
  } as OfficeRowProps)

  it('expands a render to its images through the office image slot', () => {
    const renderSlot = vi.fn(() => <div data-images />)
    const view = render(<OfficeRow {...props(settled(), renderSlot)} />)
    expect(view.container.textContent).toContain('渲染文档')
    fireEvent.click(view.container.querySelector('[data-expandable]')!)
    expect(renderSlot).toHaveBeenLastCalledWith('tool.call.office.images', { images: [{ attachment: image }], loadImage, align: 'start' })
  })

  it('shows a running call without images', () => {
    const renderSlot = vi.fn(() => <div data-images />)
    const view = render(<OfficeRow {...props(running(), renderSlot)} />)
    expect(view.container.textContent).toContain('docs/deck.pptx')
    expect(renderSlot).not.toHaveBeenCalled()
  })

  it('registers the keyed office toolview with its image child slot', () => {
    const ctx = new Context()
    const register = vi.fn()
    ctx.provide('slots', { inject: (_name: string, factory: () => unknown) => factory(), register } as never)
    officeToolview.apply(ctx)
    expect(register).toHaveBeenCalledWith(expect.objectContaining({
      name: 'tool.call.toolview', key: 'office', children: { 'tool.call.office.images': { kind: 'single', scope: 'session' } },
    }), OfficeRow)
  })
})
