// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fireEvent } from '@testing-library/react'
import type { ComposerFileIntakeTarget } from '../src/client/contract/slots.ts'
import { createComposerFileIntake } from '../src/client/input/file-intake.ts'

/** One mounted Conversation: content region, transcript, and composer card. */
function conversation(occurrence: 'main' | 'embedded', parent: HTMLElement = document.body) {
  const content = document.createElement('div')
  content.dataset.conversationContent = ''
  const transcript = document.createElement('p')
  const card = document.createElement('div')
  card.dataset.composerCard = ''
  const button = document.createElement('button')
  card.append(button)
  content.append(transcript, card)
  parent.append(content)
  const add = vi.fn<ComposerFileIntakeTarget['add']>()
  let accepting = true
  const target: ComposerFileIntakeTarget = { card, occurrence, accepts: () => accepting, add }
  return { content, transcript, card, button, add, target, refuse: () => { accepting = false } }
}

function filePayload(...files: File[]) {
  return {
    items: files.map(file => ({ kind: 'file', getAsFile: () => file })),
    getData: () => '',
  }
}

const image = new File([Uint8Array.of(1)], 'shot.png', { type: 'image/png' })

const registrations: (() => void)[] = []

/** A fresh route whose registrations the suite releases after each case. */
function createRoute(): ReturnType<typeof createComposerFileIntake> {
  const register = createComposerFileIntake()
  return (target) => {
    const leave = register(target)
    registrations.push(leave)
    return leave
  }
}

afterEach(() => {
  for (const leave of registrations.splice(0)) leave()
  document.body.replaceChildren()
})

describe('composer paste route', () => {
  it('routes an unaddressed paste to the main composer until another composer takes focus', () => {
    const register = createRoute()
    const main = conversation('main')
    const side = conversation('embedded')
    const leaveMain = register(main.target)
    const leaveSide = register(side.target)

    expect(fireEvent.paste(document.body, { clipboardData: filePayload(image) })).toBe(false)
    expect(main.add).toHaveBeenCalledWith([image], undefined)
    expect(side.add).not.toHaveBeenCalled()

    side.button.focus()
    main.transcript.tabIndex = -1
    main.transcript.focus()
    fireEvent.paste(document.body, { clipboardData: filePayload(image) })
    expect(side.add).toHaveBeenCalledTimes(1)
    expect(main.add).toHaveBeenCalledTimes(1)

    leaveSide()
    leaveSide()
    fireEvent.paste(document.body, { clipboardData: filePayload(image) })
    expect(main.add).toHaveBeenCalledTimes(2)
    leaveMain()
  })

  it('reports directory members and adopts a composer already holding focus at registration', () => {
    const register = createRoute()
    const main = conversation('main')
    const side = conversation('embedded')
    side.button.focus()
    register(main.target)
    register(side.target)
    const folder = new File([], 'folder')
    const payload = {
      items: [
        { kind: 'string', getAsFile: () => null },
        { kind: 'file', getAsFile: () => null },
        { kind: 'file', getAsFile: () => folder, webkitGetAsEntry: () => ({ isDirectory: true }) },
        { kind: 'file', getAsFile: () => image, webkitGetAsEntry: () => null },
      ],
      getData: () => '',
    }
    fireEvent.paste(document.body, { clipboardData: payload })
    expect(side.add).toHaveBeenCalledWith([folder, image], new Set([folder]))
    expect(main.add).not.toHaveBeenCalled()
  })

  it('leaves a paste to its editable control, an earlier handler, or the browser', () => {
    const register = createRoute()
    const main = conversation('main')
    register(main.target)
    const field = document.createElement('input')
    const editable = document.createElement('div')
    editable.setAttribute('contenteditable', 'true')
    document.body.append(field, editable)

    expect(fireEvent.paste(field, { clipboardData: filePayload(image) })).toBe(true)
    expect(fireEvent.paste(editable, { clipboardData: filePayload(image) })).toBe(true)
    expect(fireEvent.paste(document.body, { clipboardData: { items: [], getData: () => 'text' } })).toBe(true)
    expect(fireEvent.paste(document.body, { clipboardData: null })).toBe(true)
    const handled = (event: Event): void => { event.preventDefault() }
    document.body.addEventListener('paste', handled)
    fireEvent.paste(document.body, { clipboardData: filePayload(image) })
    document.body.removeEventListener('paste', handled)
    expect(main.add).not.toHaveBeenCalled()

    main.refuse()
    expect(fireEvent.paste(document.body, { clipboardData: filePayload(image) })).toBe(true)
    expect(main.add).not.toHaveBeenCalled()
  })

  it('never addresses a hidden, inert, detached, or modal-covered composer', () => {
    const register = createRoute()
    const main = conversation('main')
    const side = conversation('embedded')
    register(main.target)
    register(side.target)
    side.button.focus()

    side.content.setAttribute('inert', '')
    fireEvent.paste(document.body, { clipboardData: filePayload(image) })
    expect(main.add).toHaveBeenCalledTimes(1)
    side.content.removeAttribute('inert')

    const menu = document.createElement('div')
    menu.setAttribute('role', 'menu')
    document.body.append(menu)
    expect(fireEvent.paste(document.body, { clipboardData: filePayload(image) })).toBe(true)
    menu.remove()

    const dialog = document.createElement('div')
    dialog.setAttribute('role', 'dialog')
    dialog.setAttribute('aria-modal', 'true')
    const inside = conversation('embedded', dialog)
    document.body.append(dialog)
    register(inside.target)
    fireEvent.paste(document.body, { clipboardData: filePayload(image) })
    expect(inside.add).not.toHaveBeenCalled()
    inside.button.focus()
    fireEvent.paste(document.body, { clipboardData: filePayload(image) })
    expect(inside.add).toHaveBeenCalledTimes(1)
    dialog.remove()

    main.content.hidden = true
    expect(fireEvent.paste(document.body, { clipboardData: filePayload(image) })).toBe(true)
    main.content.remove()
    expect(fireEvent.paste(document.body, { clipboardData: filePayload(image) })).toBe(true)
    expect(main.add).toHaveBeenCalledTimes(1)
    expect(side.add).not.toHaveBeenCalled()
  })

  it('skips a composer that cannot accept files for the main composer, and leaves the paste when none can', () => {
    const register = createRoute()
    const main = conversation('main')
    const side = conversation('embedded')
    register(main.target)
    register(side.target)
    side.button.focus()
    side.refuse()

    expect(fireEvent.paste(document.body, { clipboardData: filePayload(image) })).toBe(false)
    expect(main.add).toHaveBeenCalledTimes(1)
    expect(side.add).not.toHaveBeenCalled()
    main.refuse()
    expect(fireEvent.paste(document.body, { clipboardData: filePayload(image) })).toBe(true)
    expect(main.add).toHaveBeenCalledTimes(1)
  })

  it('leaves a paste to an editable control inside a shadow root', () => {
    const register = createRoute()
    const main = conversation('main')
    register(main.target)
    const host = document.createElement('div')
    document.body.append(host)
    const field = document.createElement('textarea')
    host.attachShadow({ mode: 'open' }).append(field)

    expect(fireEvent.paste(field, { composed: true, clipboardData: filePayload(image) })).toBe(true)
    expect(main.add).not.toHaveBeenCalled()
  })

  it('removes its document listeners with the last registration', () => {
    const register = createRoute()
    const main = conversation('main')
    register(main.target)()
    fireEvent.paste(document.body, { clipboardData: filePayload(image) })
    expect(main.add).not.toHaveBeenCalled()
    const again = register(main.target)
    fireEvent.paste(document.body, { clipboardData: filePayload(image) })
    expect(main.add).toHaveBeenCalledTimes(1)
    again()
  })
})
