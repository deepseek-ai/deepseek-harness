// @vitest-environment jsdom
// The source row of a program call shows the program and its output without the call's description.

import { afterEach, describe, expect, it, onTestFinished } from 'vitest'
import { useDisclosure } from '@deepseek-ai/dsh-client-ui-chat/src/client/chat/use-disclosure.ts'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { en as commonEn } from '@deepseek-ai/dsh-client-locale/src/locales/en.ts'
import type { ToolResultNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import { en, zh } from '@deepseek-ai/dsh-client-ui-conversation/src/client/locales.ts'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { AttachmentId, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment/types'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ToolTreeProps } from '../src/client/contract/slots.ts'
import { SourceCodeRow, sourceCodeToolview } from '../src/client/tool/toolviews/source-code-row.tsx'

afterEach(cleanup)

const t: ToolTreeProps['t'] = makeTranslate(en, commonEn)
const ARGS = '{"description":"Capture the window","code":"inspect(await win.getScreenshot())"}'
const screenshot: ImageAttachmentRef = {
  attachmentId: brandString<AttachmentId>(`sha256:${'c'.repeat(64)}`), mediaType: 'image/png', bytes: 90, width: 1, height: 1,
}

const settled = (over: Partial<ToolResultNode> = {}): ToolResultNode => ({
  kind: 'tool-result', seq: 10, time: 2_000, callId: 'c1', name: 'cua_run_code',
  args: PartialArguments.fromText(ARGS), call: { name: 'cua_run_code', argsRaw: ARGS }, callTime: 1_000,
  content: [{ type: 'text', text: 'captured' }, { type: 'image', attachment: screenshot }],
  isError: false, subCalls: [], ...over,
})

const props = (block: ToolResultNode): Parameters<typeof SourceCodeRow>[0] => ({
  useDisclosure, callId: 'c1', toolName: block.name, phase: 'result', block, t,
} as Parameters<typeof SourceCodeRow>[0])

describe('SourceCodeRow', () => {
  it('titles the row without the description and opens the program and its output with image labels', () => {
    const view = render(<SourceCodeRow {...props(settled())} />)
    const row = view.container.querySelector('[data-variant="code"] [data-disclosure-row]')!
    expect(row.textContent).toBe('Source code')
    fireEvent.click(row)
    expect(view.container.textContent).toContain('inspect(await win.getScreenshot())')
    expect(view.container.textContent).toContain(`captured\nsha256:${'c'.repeat(64)} (1x1px, 90 bytes)`)
  })

  it('shows the first error line of a failed program', () => {
    const view = render(<SourceCodeRow {...props(settled({
      isError: true, content: [{ type: 'text', text: 'Error: code run failed (exception): boom\nCaptured output:\nlog' }],
    }))} />)
    expect(view.container.querySelector('[data-variant="code"] [data-disclosure-row]')?.textContent)
      .toBe('Source codeError: code run failed (exception): boom')
  })

  it('registers both program tools and removes them on disposal', async () => {
    const runtime = await SlotTestRuntime.create()
    onTestFinished(() => runtime.dispose())
    const locale = new LocaleRuntime(runtime.ctx)
    locale.register('conversation', { en, zh })
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    const fiber = await runtime.mount(sourceCodeToolview)
    await runtime.root.declare({ 'tool.call.toolview': { kind: 'keyed', scope: 'session' } }, () => null)
    expect(runtime.slots.entries('tool.call.toolview').map(entry => [entry.options.key, entry.component])).toEqual([
      ['run_code', SourceCodeRow], ['cua_run_code', SourceCodeRow],
    ])
    await fiber.dispose()
    expect(runtime.slots.entries('tool.call.toolview')).toHaveLength(0)
  })
})
