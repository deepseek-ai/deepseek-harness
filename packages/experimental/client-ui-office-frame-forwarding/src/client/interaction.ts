/** Read-only selection operations bound to one mounted native document. */
import type { ReactNode, KeyboardEvent, MouseEvent, RefObject } from 'react'
import type { Props } from './View.tsx'
import type { OfficeDocumentActions } from './connection.ts'
import type { FrameContentView } from '@deepseek-ai/dsh-frame-forwarding/client'
import type { OfficeDocumentInfo } from '../types.ts'
import type { OfficeInput } from './input.ts'

/** Mouse or normalized touch input accepted by native selection. */
export type OfficePointerInput = Pick<MouseEvent<HTMLCanvasElement>,
  'currentTarget' | 'clientX' | 'clientY' | 'detail' | 'buttons' | 'shiftKey' | 'ctrlKey' | 'metaKey' | 'altKey' | 'preventDefault'>

/** View state passed to the selection hook. */
export interface OfficeInteractionContext {
  documentType: OfficeDocumentInfo['documentType'] | undefined
  t: Props['t']
  request: Pick<OfficeDocumentActions, 'command' | 'input' | 'selection' | 'presentation'>
  send: Pick<OfficeDocumentActions, 'command' | 'input' | 'selection' | 'presentation'>
  inputQueue: RefObject<OfficeInput>
  busy: boolean
  action(this: void, operation: () => Promise<unknown>): void
  failAction(this: void, error: unknown): void
  renderFailure: string | undefined
  playing: boolean
  /** @returns Latest mapping submitted to FF, or undefined before the document mount is measured. */
  contentView(this: void): FrameContentView | undefined
  settling: RefObject<boolean>
  playbackTransition: RefObject<'starting' | 'stopping' | undefined>
}
/** Transient selection handlers and overlay. */
export interface OfficeInteraction {
  overlay: ReactNode
  cursor: string
  isInputTarget(this: void, target: EventTarget): boolean
  callback(this: void, event: { type?: number; payload?: string }): void
  reset(this: void): void
  focus(this: void): void
  key(this: void, event: KeyboardEvent): void
  pointer(this: void, event: OfficePointerInput, type: 0 | 1 | 2): void
  cancelPointer(this: void): void
  headerClick(this: void, event: MouseEvent<HTMLDivElement>): void
  selectHeader(this: void, range?: string): void
}
