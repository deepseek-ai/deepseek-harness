// @vitest-environment jsdom
/** Visible highlight geometry excludes clipped group content and the composer. */

import { expect, it, onTestFinished } from 'vitest'
import { visibleChatRect } from '../src/client/views/chat-node/highlight.ts'

it('keeps partially visible targets in place but excludes content behind the composer or outside a group', () => {
  const scroller = document.createElement('div')
  scroller.dataset.conversationScroll = ''
  const group = document.createElement('div')
  group.dataset.stepProcessBody = ''
  const row = document.createElement('div')
  const composer = document.createElement('div')
  composer.dataset.composerSeat = ''
  group.append(row); scroller.append(group, composer); document.body.append(scroller)
  onTestFinished(() => { scroller.remove() })
  scroller.getBoundingClientRect = () => new DOMRect(10, 10, 300, 300)
  group.getBoundingClientRect = () => new DOMRect(20, 30, 200, 220)
  composer.getBoundingClientRect = () => new DOMRect(10, 150, 300, 160)
  row.getBoundingClientRect = () => new DOMRect(20, -30, 180, 500)
  expect(visibleChatRect(row)).toEqual({ left: 20, top: 30, width: 180, height: 120 })
  row.getBoundingClientRect = () => new DOMRect(20, 170, 180, 40)
  expect(visibleChatRect(row)).toBeUndefined()
  row.getBoundingClientRect = () => new DOMRect(250, 50, 30, 40)
  expect(visibleChatRect(row)).toBeUndefined()
  expect(row.getAttribute('style')).toBeNull()
})
