import { useState } from 'react'
import type { HostObservable, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { SerializedElement, SerializedNode, SurfaceSnapshot } from '@deepseek-ai/dsh-experimental-claude-code-mods/types'
import { NS } from './locales.ts'
import css from './Band.module.css'

/** What the browser plugin injects: the session's band snapshots and the press that goes back to the Host. */
export interface BandInjected {
  hooks: { band: HostObservable<SurfaceSnapshot | undefined> }
  /** Run a button of the current drawing on the Host; resolves to the drawing after the press. */
  press: (generation: number, actionId: string) => Promise<void>
}

/** Full props of the band entry in the input dock. */
export type BandProps = PropsRuntime<'conversation.input.dock'>
  & { press: BandInjected['press']; useBand: <T>(select: (snapshot: SurfaceSnapshot | undefined) => T) => T }
  & PropsLocale<typeof NS>

/** The terminal color names Claude Code's `Text` and `Box` accept; the stylesheet maps each to a theme token. */
const COLORS: ReadonlySet<string> = new Set(['yellow', 'red', 'green', 'cyan', 'blue', 'magenta', 'gray', 'grey', 'white', 'black'])

function colorOf(value: unknown): string | undefined {
  if (typeof value !== 'string' || !COLORS.has(value)) return undefined
  return value === 'grey' ? 'gray' : value
}

function flag(value: unknown): true | undefined {
  return value === true ? true : undefined
}

function textAttributes(props: SerializedElement['props']): Record<string, string | true | undefined> {
  return {
    'data-color': colorOf(props['color']),
    'data-bold': flag(props['bold']),
    'data-dim': flag(props['dimColor']),
    'data-italic': flag(props['italic']),
    'data-underline': flag(props['underline']),
  }
}

function boxStyle(props: SerializedElement['props']): { attributes: Record<string, string | true | undefined>; style: Record<string, string> } {
  const style: Record<string, string> = {}
  const unit = (value: unknown): string | undefined => typeof value === 'number' ? `${value * 4}px` : undefined
  const paddingX = unit(props['paddingX'] ?? props['padding'])
  const paddingY = unit(props['paddingY'] ?? props['padding'])
  if (paddingX !== undefined) style.paddingLeft = style.paddingRight = paddingX
  if (paddingY !== undefined) style.paddingTop = style.paddingBottom = paddingY
  const gap = unit(props['gap'])
  if (gap !== undefined) style.gap = gap
  const bordered = props['border'] !== undefined && props['border'] !== false
  return {
    attributes: {
      'data-direction': props['flexDirection'] === 'row' ? 'row' : 'column',
      'data-border': bordered ? true : undefined,
      'data-color': bordered ? colorOf(props['borderColor']) : undefined,
    },
    style,
  }
}

interface NodeProps {
  readonly node: SerializedNode
  readonly path: string
  readonly generation: number
  readonly pending: string | undefined
  readonly onPress: (actionId: string) => void
  readonly hotkeyLabel: (hotkey: string) => string
}

function Node({ node, path, generation, pending, onPress, hotkeyLabel }: NodeProps) {
  if (typeof node === 'string') return <>{node}</>
  const children = node.children.map((child, index) => (
    <Node key={`${path}.${index}`} node={child} path={`${path}.${index}`} generation={generation} pending={pending} onPress={onPress} hotkeyLabel={hotkeyLabel} />
  ))
  if (node.type === 'Text') return <span className={css.text} {...textAttributes(node.props)}>{children}</span>
  if (node.type === 'Button') {
    const label = String(node.props['label'])
    const hotkey = typeof node.props['hotkey'] === 'string' ? node.props['hotkey'] : undefined
    // A Button without an action id has no onPress: drawn, never pressable.
    const actionId = node.actionId ?? ''
    const disabled = node.props['disabled'] === true || actionId === '' || pending !== undefined
    return (
      <button
        type="button"
        className={css.button}
        disabled={disabled}
        aria-busy={pending === actionId}
        onClick={() => { onPress(actionId) }}
      >
        {label}
        {hotkey === undefined ? null : <span className={css.hotkey}>{hotkeyLabel(hotkey)}</span>}
      </button>
    )
  }
  const { attributes, style } = boxStyle(node.props)
  return <div className={css.box} style={style} {...attributes}>{children}</div>
}

/**
 * The band above the prompt: the session's current mod drawing, with buttons
 * that run their `onPress` on the Host. Hotkeys are shown as hints; a press is
 * a click.
 */
export function Band({ press, useBand, t }: BandProps) {
  const snapshot = useBand(value => value)
  const [pending, setPending] = useState<string | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)
  if (snapshot === undefined || snapshot.tree === null) return null
  const onPress = (actionId: string): void => {
    setPending(actionId)
    setNotice(undefined)
    press(snapshot.generation, actionId).then(
      () => { setPending(undefined) },
      (error: unknown) => {
        setPending(undefined)
        setNotice(t('press.failed', { message: error instanceof Error ? error.message : String(error) }))
      },
    )
  }
  return (
    <div className={css.band} role="group" aria-label={t('band')} data-generation={snapshot.generation}>
      {snapshot.tree.map((node, index) => (
        <span key={`${snapshot.generation}.${index}`} className={css.text}>
          <Node node={node} path={String(index)} generation={snapshot.generation} pending={pending} onPress={onPress} hotkeyLabel={hotkey => `[${hotkey}]`} />
        </span>
      ))}
      {notice === undefined ? null : <div className={css.notice} role="status">{notice}</div>}
    </div>
  )
}
