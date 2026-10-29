/** DOM gesture bindings owned by one menu plugin instance. */
import type { SyntheticEvent } from 'react'
import type { ContextMenuTriggerProps, MenuPoint, ContextMenuTarget } from './types.ts'

/**
 * Create stable bindings for the plugin's injected hook.
 * @param open - Open against the supplied captured target and viewport position.
 * @param active - Whether the plugin still owns its service.
 * @returns Ordinary trigger-prop factory; no React subscription or context is created.
 */
export function createContextMenuBindings<Target extends object = ContextMenuTarget>(
  open: (target: Target, point: MenuPoint) => void, active: () => boolean,
): { getTriggerProps: (target: Target | (() => Target) | undefined, handlers?: ContextMenuTriggerProps) => ContextMenuTriggerProps } {
  return {
    getTriggerProps(target, handlers = {}) {
      if (target === undefined) return handlers
      const show = (event: SyntheticEvent<HTMLElement>, x: number, y: number): void => {
        if (event.defaultPrevented || !active()) return
        const captured = typeof target === 'function' ? target() : target
        event.preventDefault()
        event.stopPropagation()
        event.currentTarget.focus({ preventScroll: true })
        open(captured, { x, y })
      }
      return {
        ...handlers,
        tabIndex: handlers.tabIndex ?? 0,
        onContextMenu(event) {
          handlers.onContextMenu?.(event)
          const rect = event.clientX === 0 && event.clientY === 0 ? event.currentTarget.getBoundingClientRect() : undefined
          show(event, rect?.left ?? event.clientX, rect?.bottom ?? event.clientY)
        },
        onKeyDown(event) {
          handlers.onKeyDown?.(event)
          if (event.defaultPrevented || event.repeat || event.nativeEvent.isComposing || event.ctrlKey || event.altKey || event.metaKey
            || !(event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey)) return
          const rect = event.currentTarget.getBoundingClientRect()
          show(event, rect.left, rect.bottom)
        },
      }
    },
  }
}
