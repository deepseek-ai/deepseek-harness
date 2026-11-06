/**
 * Document-level paste routing across every mounted composer.
 *
 * A file paste outside an editable control addresses at most one composer:
 * the one that most recently held focus while it can accept files, otherwise
 * the main Conversation's composer while it can. A composer inside a hidden or
 * inert subtree, or behind the foreground modal dialog or menu, is never
 * addressed.
 */
import { modalSelector } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ComposerFileIntake, ComposerFileIntakeTarget } from '../contract/slots.ts'

/** Controls that own their own paste; the document-level route never takes it from them. */
const EDITABLE = 'input, textarea, select, [contenteditable]:not([contenteditable="false"])'

/**
 * Clipboard files in clipboard order, with members the entry API reports as directories.
 * @param transfer - clipboard payload of one paste event.
 * @returns the pasted files and their directory members; empty when the payload has no file item.
 */
export function clipboardFiles(transfer: DataTransfer): { files: File[]; directories: Set<File> } {
  const files: File[] = []
  const directories = new Set<File>()
  for (const item of transfer.items) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file === null) continue
    files.push(file)
    if (typeof item.webkitGetAsEntry === 'function' && item.webkitGetAsEntry()?.isDirectory === true) {
      directories.add(file)
    }
  }
  return { files, directories }
}

/**
 * Create the paste router shared by the composers of one plugin instance.
 * Its document listeners exist only while at least one composer is registered.
 * @returns the registration callback injected into each composer.
 */
export function createComposerFileIntake(): ComposerFileIntake {
  const targets = new Set<ComposerFileIntakeTarget>()
  let focused: ComposerFileIntakeTarget | undefined
  let uninstall: (() => void) | undefined

  const addressable = (document: Document): ComposerFileIntakeTarget[] => {
    const foreground = [...document.querySelectorAll(modalSelector)].at(-1)
    return [...targets].filter(target => target.card.isConnected
      && target.card.closest('[inert], [hidden]') === null
      && (foreground === undefined || foreground.contains(target.card)))
  }
  const pasteTarget = (document: Document): ComposerFileIntakeTarget | undefined => {
    const candidates = addressable(document).filter(target => target.accepts())
    if (focused !== undefined && candidates.includes(focused)) return focused
    return candidates.find(target => target.occurrence === 'main')
  }

  const install = (document: Document): () => void => {
    const focusin = (event: FocusEvent): void => {
      // Document focusin events always target a node of this document.
      const node = event.target as Node
      const target = [...targets].find(candidate => candidate.card.contains(node))
      if (target !== undefined) focused = target
    }
    const paste = (event: ClipboardEvent): void => {
      // A focused composer editor consumes its own paste before bubbling here.
      if (event.defaultPrevented || event.clipboardData === null) return
      // The first path element sees through shadow roots, which retarget event.target to their host.
      const origin = event.composedPath().find(value => value instanceof Element)
      if (origin instanceof Element && origin.closest(EDITABLE) !== null) return
      const { files, directories } = clipboardFiles(event.clipboardData)
      if (files.length === 0) return
      const target = pasteTarget(document)
      if (target === undefined) return
      event.preventDefault()
      target.add(files, directories.size === 0 ? undefined : directories)
    }
    document.addEventListener('focusin', focusin, true)
    document.addEventListener('paste', paste)
    return () => {
      document.removeEventListener('focusin', focusin, true)
      document.removeEventListener('paste', paste)
    }
  }

  return (target) => {
    targets.add(target)
    const document = target.card.ownerDocument
    if (target.card.contains(document.activeElement)) focused = target
    uninstall ??= install(document)
    return () => {
      targets.delete(target)
      if (focused === target) focused = undefined
      if (targets.size > 0) return
      uninstall?.()
      uninstall = undefined
    }
  }
}
