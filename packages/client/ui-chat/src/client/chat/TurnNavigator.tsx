/** Fixed-pitch virtual turn rail with independent activation and scroll controls. */
import {
  forwardRef, memo, useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState,
  type CSSProperties, type ForwardedRef,
} from 'react'
import { defaultRangeExtractor, elementScroll, observeElementOffset, useVirtualizer, type Range } from '@tanstack/react-virtual'
import type { ChatViewSlotProps } from '../contract/slots.ts'
import type { TurnRailItem } from './turn-rail-items.ts'
import css from './TurnNavigator.module.css'

interface TurnNavigatorProps {
  readonly items: readonly TurnRailItem[]
  readonly activeTurn: number | null
  /** Turn whose jump is still paging history in; its mark pulses. */
  readonly busyTurn: number | null
  readonly onNavigate: (item: TurnRailItem) => void
  readonly t: ChatViewSlotProps['t']
}

/** Imperative controls for known turns; unknown turn numbers are ignored. */
export interface TurnNavigatorHandle {
  /** @param turn - turn to activate through the navigation callback. */
  activateTurn(turn: number): void
  /** @param turn - turn to center in the rail without navigating the transcript. */
  scrollToTurn(turn: number): void
}

/** Fixed pitch between neighbouring marks; overflow scrolls inside the frame. */
const TURN_SPACING_PX = 10
/** Rail padding above the first mark and below the last one, per end. */
const RAIL_INSET_PX = 6
/** Fade band the mask reserves at a scrollable end. */
const FADE_PX = 24

function preferredScrollBehavior(): 'auto' | 'smooth' {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
    ? 'auto'
    : 'smooth'
}

interface TurnMarkProps extends Pick<TurnNavigatorProps, 'onNavigate' | 't'> {
  readonly item: TurnRailItem
  readonly index: number
  readonly active: boolean
  readonly busy: boolean
  readonly previewId: string | undefined
  readonly registerElement: (element: HTMLButtonElement | null) => void
  readonly onPreview: (turn: number | null) => void
  readonly onFocusChange: (turn: number | null) => void
}

const TurnMark = memo(function TurnMark({
  item, index, active, busy, previewId, registerElement, onNavigate, onPreview, onFocusChange, t,
}: TurnMarkProps) {
  const classes = [css.mark]
  if (item.anchor.kind === 'unloaded') classes.push(css.markUnloaded)
  if (active) classes.push(css.markActive)
  else if (previewId !== undefined) classes.push(css.markPreview)
  if (busy) classes.push(css.markBusy)
  return (
    <button
      ref={registerElement}
      data-index={index}
      type="button"
      className={classes.join(' ')}
      aria-label={t(
        item.anchor.kind === 'loaded' ? 'chat.turnNavigation.jump' : 'chat.turnNavigation.jumpLoad',
        { turn: item.turn },
      )}
      aria-current={active ? 'true' : undefined}
      aria-busy={busy ? 'true' : undefined}
      aria-describedby={previewId}
      onPointerMove={() => { onPreview(item.turn) }}
      onClick={() => { onNavigate(item) }}
      onFocus={() => { onFocusChange(item.turn) }}
      onBlur={() => { onFocusChange(null) }}
    />
  )
})

function TurnNavigatorRail(
  { items, activeTurn, busyTurn, onNavigate, t }: TurnNavigatorProps,
  ref: ForwardedRef<TurnNavigatorHandle>,
) {
  const [previewTurn, setPreviewTurn] = useState<number | null>(null)
  const [focusedTurn, setFocusedTurn] = useState<number | null>(null)
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const initialization = useRef({
    placed: false,
    index: 0,
    follow: null as { index: number; count: number; height: number } | null,
    publishOffset: null as ((offset: number, scrolling: boolean) => void) | null,
  })
  /** While the pointer works the rail, follow must not move it under the hand. */
  const pointerInsideRef = useRef(false)
  const previewId = useId()
  const turnIndexes = useMemo(() => {
    const indexes = new Map<number, number>()
    items.forEach((item, index) => { indexes.set(item.turn, index) })
    return indexes
  }, [items])
  const activeIndex = activeTurn === null ? undefined : turnIndexes.get(activeTurn)
  useLayoutEffect(() => { initialization.current.index = activeIndex ?? 0 }, [activeIndex])
  const focusedIndex = focusedTurn === null ? undefined : turnIndexes.get(focusedTurn)
  const previewIndex = previewTurn === null ? undefined : turnIndexes.get(previewTurn)
  const onFocusChange = useCallback((turn: number | null) => {
    setFocusedTurn(turn)
    setPreviewTurn(turn)
  }, [])
  const virtualizer = useVirtualizer<HTMLDivElement, HTMLButtonElement>({
    count: items.length,
    enabled: items.length >= 2,
    directDomUpdates: true,
    directDomUpdatesMode: 'transform',
    useScrollendEvent: true,
    getScrollElement: useCallback(() => scrollerRef.current, []),
    getItemKey: useCallback((index: number) => items[index]?.turn ?? index, [items]),
    estimateSize: () => TURN_SPACING_PX,
    measureElement: () => TURN_SPACING_PX,
    initialRect: { width: 0, height: 0 },
    initialOffset: 0,
    scrollToFn: (offset, options, instance) => {
      if (initialization.current.placed) elementScroll(offset, options, instance)
    },
    observeElementOffset: (instance, notify) => {
      initialization.current.publishOffset = notify
      const dispose = observeElementOffset(instance, notify)
      return () => {
        dispose?.()
        initialization.current.placed = false
        initialization.current.follow = null
        initialization.current.publishOffset = null
      }
    },
    observeElementRect: (instance, notify) => {
      const element = instance.scrollElement
      const Observer = instance.targetWindow?.ResizeObserver
      if (element === null || Observer === undefined) return
      const observer = new Observer(([entry]) => {
        if (entry === undefined) return
        const box = entry.borderBoxSize[0]
        const rect = {
          width: Math.round(box?.inlineSize ?? entry.contentRect.width),
          height: Math.round(box?.blockSize ?? entry.contentRect.height),
        }
        const initial = initialization.current
        if (!initial.placed && rect.height > 0) {
          const max = Math.max(0, instance.getTotalSize() - rect.height)
          const center = initial.index * TURN_SPACING_PX + RAIL_INSET_PX
          const target = Math.max(0, Math.min(max, center - rect.height / 2))
          initial.placed = true
          initial.follow = { index: initial.index, count: instance.options.count, height: rect.height }
          element.scrollTop = target
          initial.publishOffset?.(target, false)
        }
        notify(rect)
      })
      observer.observe(element, { box: 'border-box' })
      return () => { observer.disconnect() }
    },
    paddingStart: RAIL_INSET_PX - TURN_SPACING_PX / 2,
    paddingEnd: RAIL_INSET_PX - TURN_SPACING_PX / 2,
    scrollPaddingStart: FADE_PX,
    scrollPaddingEnd: FADE_PX,
    overscan: 3,
    rangeExtractor: useCallback((range: Range) => {
      const indexes = defaultRangeExtractor(range)
      if (focusedIndex !== undefined) {
        const last = Math.min(range.count - 1, focusedIndex + 1)
        for (let index = Math.max(0, focusedIndex - 1); index <= last; index++) {
          if (!indexes.includes(index)) indexes.push(index)
        }
        indexes.sort((left, right) => left - right)
      }
      return indexes
    }, [focusedIndex]),
  })
  const scrollTop = virtualizer.scrollOffset ?? 0
  const viewHeight = virtualizer.scrollRect?.height ?? 0
  const virtualItems = virtualizer.getVirtualItems()

  const scrollToIndex = useCallback((
    index: number, reveal: 'if-needed' | 'always', behavior: 'auto' | 'smooth' | 'instant' = preferredScrollBehavior(),
  ): void => {
    const item = virtualizer.measurementsCache[index]
    const height = virtualizer.scrollRect?.height ?? 0
    if (item === undefined || height <= 0) return
    const current = virtualizer.scrollOffset ?? 0
    const center = item.start + item.size / 2
    if (reveal === 'if-needed') {
      const { scrollPaddingStart, scrollPaddingEnd } = virtualizer.options
      if (center >= current + scrollPaddingStart && center <= current + height - scrollPaddingEnd) return
    }
    const target = center - height / 2
    const max = Math.max(0, virtualizer.getTotalSize() - height)
    const delta = Math.max(0, Math.min(max, target)) - current
    if (delta !== 0) virtualizer.scrollBy(delta, { behavior })
  }, [virtualizer])

  useImperativeHandle(ref, (): TurnNavigatorHandle => ({
    activateTurn(turn) {
      const index = turnIndexes.get(turn)
      const item = index === undefined ? undefined : items[index]
      if (item !== undefined) onNavigate(item)
    },
    scrollToTurn(turn) {
      const index = turnIndexes.get(turn)
      if (index !== undefined) scrollToIndex(index, 'always')
    },
  }), [items, turnIndexes, onNavigate, scrollToIndex])

  useEffect(() => {
    if (viewHeight <= 0) {
      initialization.current.follow = null
      return
    }
    if (activeIndex === undefined || pointerInsideRef.current) return
    const previous = initialization.current.follow
    if (previous?.index === activeIndex && previous.count === items.length && previous.height === viewHeight) return
    initialization.current.follow = { index: activeIndex, count: items.length, height: viewHeight }
    const behavior = previous?.count === items.length && previous.height === viewHeight
      ? preferredScrollBehavior()
      : 'instant'
    scrollToIndex(activeIndex, 'if-needed', behavior)
  }, [activeIndex, items.length, viewHeight, scrollToIndex])

  if (items.length < 2) return null
  const preview = previewIndex === undefined ? undefined : items[previewIndex]
  const previewPosition = virtualItems.find(item => item.index === previewIndex)
  const fadeClasses = [css.scroller]
  if (scrollTop > 1) fadeClasses.push(css.fadeTop)
  if (scrollTop < virtualizer.getTotalSize() - viewHeight - 1) fadeClasses.push(css.fadeBottom)
  return (
    <div className={css.slot}>
      <nav
        className={css.frame}
        aria-label={t('chat.turnNavigation.label')}
        onPointerEnter={() => { pointerInsideRef.current = true }}
        onPointerLeave={() => {
          pointerInsideRef.current = false
          setPreviewTurn(null)
        }}
      >
        <div ref={scrollerRef} className={fadeClasses.join(' ')}>
          <div ref={virtualizer.containerRef} className={css.marks}>
            {virtualItems.map(({ index, key }) => {
              const item = items[index]
              if (item === undefined) return null
              return (
                <TurnMark
                  key={key}
                  item={item}
                  index={index}
                  active={item.turn === activeTurn}
                  busy={item.turn === busyTurn}
                  previewId={item.turn === previewTurn ? previewId : undefined}
                  registerElement={virtualizer.measureElement}
                  onNavigate={onNavigate}
                  onPreview={setPreviewTurn}
                  onFocusChange={onFocusChange}
                  t={t}
                />
              )
            })}
          </div>
        </div>
        {preview !== undefined && previewPosition !== undefined && (
          <div
            id={previewId}
            role="tooltip"
            className={css.preview}
            style={{
              '--turn-preview-center': `${String(previewPosition.start + previewPosition.size / 2 - scrollTop)}px`,
            } as CSSProperties}
          >
            <div className={css.previewPrompt}>
              {preview.prompt || t('chat.turnNavigation.turn', { turn: preview.turn })}
            </div>
            {preview.response !== '' && <div className={css.previewResponse}>{preview.response}</div>}
          </div>
        )}
      </nav>
    </div>
  )
}

/**
 * Fixed-pitch rail of every known Turn — loaded marks scroll, unloaded marks
 * page history in first — with hover and focus previews. Overflow scrolls
 * inside the frame, gradient fades marking each scrollable end, and the
 * active mark centers only outside the fade-free band while the pointer is
 * elsewhere. Previews follow pointer movement or focus, not scrolling under
 * a stationary pointer.
 */
export const TurnNavigator = memo(forwardRef(TurnNavigatorRail))
