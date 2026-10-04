// @vitest-environment jsdom
/** DOM and row matching retain useful parents when a precise target is unavailable. */

import { expect, it, onTestFinished, vi } from 'vitest'
import { findChatTargets } from '../src/client/views/chat-node/dom.ts'
import { matchChatElement, matchChatNodeRow } from '../src/client/views/chat-node/pick-match.ts'
import { placeChatHighlight } from '../src/client/views/chat-node/highlight.ts'

it('falls back to a root tool, Group, or Turn within the same Conversation', () => {
  const root = document.createElement('div')
  root.dataset.slot = 'conversation.view'
  root.innerHTML = '<div data-chat-call-id="root-call"></div><div data-chat-group-key="group"></div><div data-chat-turn="2"></div>'
  document.body.append(root)
  onTestFinished(() => { root.remove() })
  expect(findChatTargets(root, [{ nodeKey: 'removed', rootCallId: 'root-call' }])).toEqual([root.children[0]])
  expect(findChatTargets(root, [{ groupKey: 'group' }])).toEqual([root.children[1]])
  expect(findChatTargets(root, [{ turn: 2 }])).toEqual([root.children[2]])
  expect(findChatTargets(root, [{ groupKey: 'missing', turn: 3, rootCallId: 'missing' }])).toEqual([])
  expect(matchChatElement(root.children[2]!, root)).toEqual({ element: root.children[2], target: { turn: 2 } })
  expect(matchChatElement(root, root)).toBeUndefined()
  expect(placeChatHighlight(document.createElement('div'), root)).toBe(false)
})

it('falls back from a missing Node or Group to the loaded Turn without inventing rows', () => {
  const rows = new Map([
    ['first', { nodeKey: 'first', turn: 1, step: 1 }],
    ['second', { nodeKey: 'second', turn: 1, step: 2 }],
  ])
  expect(matchChatNodeRow({ nodeKey: 'missing', groupKey: 'missing', turn: 1, step: 9 }, rows)).toBe('first')
  expect(matchChatNodeRow({ nodeKey: 'missing' }, rows)).toBeUndefined()
  expect(matchChatNodeRow({}, rows)).toBeUndefined()
})

it('keeps nearby Nodes ahead of Turn headers and excludes nested Conversations with one DOM scan', () => {
  const root = document.createElement('div')
  root.dataset.slot = 'conversation.view'
  root.innerHTML = '<div data-chat-turn="1"></div><div data-chat-node-key="near" data-chat-turn="1"></div>'
    + '<div data-chat-node-key="other" data-chat-turn="2"></div>'
    + '<div data-slot="conversation.view"><div data-chat-node-key="near" data-chat-turn="1"></div></div>'
  document.body.append(root)
  onTestFinished(() => { root.remove() })
  const scan = vi.spyOn(root, 'querySelectorAll')
  onTestFinished(() => { scan.mockRestore() })
  expect(findChatTargets(root, [
    { nodeKey: 'absent', turn: 1 }, { nodeKey: 'near', turn: 1 }, { nodeKey: 'near', turn: 1 }, { nodeKey: 'other', turn: 2 },
  ])).toEqual([root.children[1], root.children[0], root.children[2]])
  expect(scan).toHaveBeenCalledOnce()
})
