// @vitest-environment jsdom
/** Promotion preserves the displayed rectangle while the next card changes content height. */
import { afterEach, expect, it, vi } from 'vitest'
import { dismissNotice } from '../src/client/notice-transition.ts'

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks() })

it.each(['unavailable', 'reduced motion'])('closes without animation when animation is %s', (mode) => {
  const card = document.createElement('aside')
  document.body.append(card)
  const animate = vi.fn<HTMLElement['animate']>()
  if (mode === 'reduced motion') {
    card.animate = animate
    card.style.transitionDuration = '0s'
  }
  const dismiss = vi.fn(() => { card.remove() })
  dismissNotice(card, dismiss)
  expect(dismiss).toHaveBeenCalledOnce()
  expect(animate).not.toHaveBeenCalled()
})

it('animates a surviving card from its old position and height and cancels an interrupted transition', () => {
  const stack = document.createElement('div')
  const first = document.createElement('aside')
  const next = document.createElement('aside')
  stack.append(first, next)
  document.body.append(stack)
  first.style.transitionDuration = '0.25s'
  const animateFirst = vi.fn<HTMLElement['animate']>()
  const animateNext = vi.fn<HTMLElement['animate']>()
  first.animate = animateFirst
  next.animate = animateNext
  first.getAnimations = () => []
  const cancel = vi.fn()
  const interrupted: Pick<Animation, 'cancel'> = { cancel }
  next.getAnimations = () => [interrupted as Animation]
  vi.spyOn(next, 'getBoundingClientRect')
    .mockReturnValueOnce(new DOMRect(14, 196, 272, 100))
    .mockReturnValueOnce(new DOMRect(10, 100, 280, 200))
  next.style.transform = 'translateY(0px) scaleX(1)'
  dismissNotice(first, () => { first.remove() })
  expect(cancel).toHaveBeenCalledOnce()
  expect(animateFirst).not.toHaveBeenCalled()
  expect(animateNext).toHaveBeenCalledWith([
    { transform: 'translate(0px, 96px) scale(0.9714285714285714, 0.5)' },
    { transform: 'translateY(0px) scaleX(1)' },
  ], { duration: 250, easing: 'ease-out' })
  expect(next.style.transition).toBe('')
})
