/** Test-only access to the assembled viewer page's real input facade and quiescent boot disposal. */
import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { mountViewerPage, type AssembledViewerPage, type ViewerPageTarget } from './viewer-page.client.ts'

/** Owned browser state for one assembled viewer test. */
export interface ViewerInputFixture {
  /**
   * Boot the assembled viewer page for one share.
   * @param container - Application mount point.
   * @param target - Share the carrier names.
   */
  mount(container: HTMLElement, target: ViewerPageTarget): Promise<void>
  /** A booted client Context, available after the page's plugins activated. */
  context(): Context
  /** Enter text through the real Session input API and click its mounted Send control. */
  send(sessionId: string, text: string, sendLabel: string): Promise<void>
  /** Dispose the application before releasing its transport, then restore exact browser state. */
  dispose(): Promise<void>
}

/**
 * Save browser globals before the page installs its module system and carrier.
 * @returns Access to the assembled input API and async cleanup.
 */
export function installViewerInputFixture(): ViewerInputFixture {
  const globals = ['__DSH_BOOT__', '__ModuleLoader__', '__DSH_LIVESHARE_VIEWER__', '__DSH_TRANSPORT__']
  const saved = globals.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const)
  const savedLanguages = ['languages', 'language'].map(key =>
    [key, Object.getOwnPropertyDescriptor(navigator, key)] as const)
  const savedHidden = Object.getOwnPropertyDescriptor(document, 'hidden')
  Object.defineProperty(document, 'hidden', { configurable: true, value: false })
  const savedDocumentElement = [...document.documentElement.attributes].map(attribute => [attribute.name, attribute.value] as const)
  const savedBodyStyle = document.body.getAttribute('style')
  const savedTitle = document.title
  const savedUrl = location.href
  const savedFonts = Object.getOwnPropertyDescriptor(document, 'fonts')
  const savedRange = Object.getOwnPropertyDescriptor(Range.prototype, 'getBoundingClientRect')
  if (document.fonts === undefined) {
    Object.defineProperty(document, 'fonts', { configurable: true, value: new EventTarget() })
  }
  Object.defineProperty(Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value: () => ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }),
  })
  let page: AssembledViewerPage | undefined
  const context = (): Context => {
    if (page === undefined) throw new Error('viewer input probe: application has not booted')
    return page.context()
  }
  return {
    async mount(container, target) {
      page = await mountViewerPage(container, target)
    },
    context,
    async send(sessionId, text, sendLabel) {
      const scope = context().get('sessions')?.scope(sessionId as SessionId)
      if (scope === undefined) throw new Error(`viewer input probe: no retained scope for ${sessionId}`)
      const input = context().get('conversation')?.input.for(scope)
      if (input === undefined) throw new Error('viewer input probe: input facade is unavailable')
      // jsdom lacks beforeinput target ranges. The InputBar fixture uses this same Lexical-backed API.
      await act(async () => { input.setDraft(text) })
      await waitFor(() => {
        const editor = document.querySelector('[contenteditable="true"]')
        if (editor?.textContent !== text) throw new Error('viewer input probe: draft did not reach the mounted editor')
      })
      const send = screen.getByRole('button', { name: sendLabel })
      if ((send as HTMLButtonElement).disabled) throw new Error('viewer input probe: Send remains disabled')
      await act(async () => { fireEvent.click(send) })
    },
    async dispose() {
      await page?.dispose()
      page = undefined
      for (const [key, descriptor] of saved) restore(globalThis, key, descriptor)
      for (const [key, descriptor] of savedLanguages) restore(navigator, key, descriptor)
      restore(document, 'fonts', savedFonts)
      restore(document, 'hidden', savedHidden)
      restore(Range.prototype, 'getBoundingClientRect', savedRange)
      for (const attribute of [...document.documentElement.attributes]) document.documentElement.removeAttribute(attribute.name)
      for (const [name, value] of savedDocumentElement) document.documentElement.setAttribute(name, value)
      if (savedBodyStyle === null) document.body.removeAttribute('style')
      else document.body.setAttribute('style', savedBodyStyle)
      document.title = savedTitle
      history.replaceState(null, '', savedUrl)
    },
  }
}

/** Restore an own property, preserving the distinction between absent and present. */
function restore(target: object, key: string, descriptor: PropertyDescriptor | undefined): void {
  if (descriptor === undefined) Reflect.deleteProperty(target, key)
  else Object.defineProperty(target, key, descriptor)
}

/**
 * Assert a prompt's durable user/message matches the exact scripted Owner request id.
 * @param events - Durable Owner events, read after acceptance.
 * @param request - Exact request observed at the Owner transport.
 * @returns The unique durable user echo for the request.
 */
export function promptEcho(
  events: readonly import('@deepseek-ai/dsh-session/types').SessionEvent[],
  request: { readonly requestId: string; readonly content: readonly { readonly type: string; readonly text?: string }[] },
): import('@deepseek-ai/dsh-session/types').SessionEvent {
  const matches = events.filter(event => event.type === 'user/message'
    && Reflect.get(event.data.source, 'rpcId') === request.requestId)
  if (matches.length !== 1) throw new Error(`viewer input probe: expected one durable echo, got ${String(matches.length)}`)
  const event = matches[0]
  if (event === undefined || event.type !== 'user/message') throw new Error('viewer input probe: durable echo is missing')
  const actual = event.data.content.map(block => block.type === 'text' ? block.text : '').join('')
  const expected = request.content.map(block => block.type === 'text' ? block.text ?? '' : '').join('')
  if (actual !== expected) throw new Error('viewer input probe: durable user text differs from the Owner request')
  return event
}
