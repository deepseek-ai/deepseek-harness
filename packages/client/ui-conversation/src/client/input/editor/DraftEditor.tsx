/** Text-area presentation over the InputBar's borrowed editor. */
import { useId } from 'react'
import type { CSSProperties, KeyboardEventHandler, ReactNode, RefObject } from 'react'
import type { LexicalEditor } from 'lexical'
import clsx from 'clsx'
import { HoverCardGroup } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputState } from '../../contract/input.ts'
import { ComposerContentEditable } from './ComposerContentEditable.tsx'
import { DecoratorPortals } from './DecoratorPortals.tsx'

/** Text-area values and the scrollport reference retained by InputBar. */
export interface DraftEditorProps {
  readonly classNames: Readonly<Record<string, string>>
  readonly editor: LexicalEditor | null
  readonly scrollRef: RefObject<HTMLDivElement>
  readonly editable: boolean
  readonly editorDisabled: boolean
  readonly phase: InputState['phase'] | 'inert'
  readonly placeholderText: string
  /** Session eligible for plugin guidance while the empty editor accepts input. */
  readonly placeholderSessionId: SessionId | undefined
  readonly renderSlotChain: PropsRenderSlots<'conversation.input.placeholder'>['renderSlotChain']
  readonly ariaLabel: string
  readonly workspaceTrigger: boolean
  readonly workspacePickerOpen: boolean
  readonly onWorkspaceKeyDown: KeyboardEventHandler<HTMLDivElement>
  readonly hint: string | null
  readonly showPlaceholder: boolean
}

/**
 * Render the existing scrollport, editable surface, placeholder, and chip portals.
 * @param props - borrowed editor, presentation values and placeholder slot renderer.
 * @returns the existing text-area DOM without an additional wrapper.
 */
export function DraftEditor({
  classNames: css, editor, scrollRef, editable, editorDisabled, phase, placeholderText, ariaLabel,
  workspaceTrigger, workspacePickerOpen, onWorkspaceKeyDown, hint, showPlaceholder, placeholderSessionId, renderSlotChain,
}: DraftEditorProps): ReactNode {
  const placeholderId = useId()
  return (
    <div ref={scrollRef} className={css.scroll} data-input-scroll>
      <HoverCardGroup className={css.grow}>
        <ComposerContentEditable
          editor={workspaceTrigger ? null : editor}
          editable={editable}
          className={clsx(css.input, editorDisabled && css.inputDisabled)}
          data-phase={phase}
          aria-disabled={editorDisabled || undefined}
          data-placeholder={placeholderText}
          aria-label={ariaLabel}
          aria-labelledby={showPlaceholder && placeholderSessionId !== undefined ? placeholderId : undefined}
          aria-haspopup={workspaceTrigger ? 'menu' : undefined}
          aria-expanded={workspaceTrigger ? workspacePickerOpen : undefined}
          tabIndex={workspaceTrigger ? 0 : undefined}
          onKeyDown={workspaceTrigger ? onWorkspaceKeyDown : undefined}
          style={hint === null ? undefined : { '--dsh-composer-hint': JSON.stringify(hint) } as CSSProperties}
        />
        {showPlaceholder && (
          <div id={placeholderId} aria-hidden className={css.placeholder} data-composer-placeholder>
            {placeholderSessionId === undefined
              ? placeholderText
              : renderSlotChain('conversation.input.placeholder', { sessionId: placeholderSessionId }, { fallback: placeholderText })}
          </div>
        )}
        <DecoratorPortals editor={workspaceTrigger ? null : editor} />
      </HoverCardGroup>
    </div>
  )
}
