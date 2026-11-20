/** Native fullscreen material changes through the shipped sidebar composition. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

it.each(['light', 'dark'] as const)('fades the macOS fullscreen backing without fading content in %s mode', async (colorScheme) => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  try {
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, colorScheme, locale: 'en-US' })
      await page.goto(scaffold.authenticatedUrl)
      await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor()
      await page.evaluate(() => { document.documentElement.dataset.platform = 'darwin' })
      const column = page.locator('[data-slot="sidebar"]').locator('..')
      await column.evaluate((el) => {
        for (const animation of el.getAnimations({ subtree: true })) animation.finish()
      })

      // The preload marker is emulated here; native window animation is checked on macOS Desktop.
      for (const fullscreen of [true, false]) {
        const sample = await column.evaluate((el, fullscreen) => {
          const before = getComputedStyle(el).backgroundImage
          const root = document.documentElement
          root.toggleAttribute('data-fullscreen', fullscreen)
          getComputedStyle(el, '::before').getPropertyValue('opacity')
          const animations = el.getAnimations({ subtree: true })
          const backing = animations.find(animation =>
            animation instanceof CSSTransition && animation.transitionProperty === 'opacity'
            && animation.effect instanceof KeyframeEffect && animation.effect.pseudoElement === '::before')
          if (backing === undefined || !(backing.effect instanceof KeyframeEffect)) {
            throw new Error('Fullscreen backing opacity transition is missing')
          }
          try {
            for (const animation of animations) {
              animation.pause()
              animation.currentTime = Number(animation.effect!.getComputedTiming().duration) / 2
            }
            const style = getComputedStyle(el, '::before')
            const button = el.querySelector('[data-slot="sidebar.session.action"] button')!
            return {
              endpoints: backing.effect.getKeyframes().map(keyframe => Number(keyframe.opacity)),
              duration: backing.effect.getComputedTiming().duration,
              opacity: Number(style.opacity),
              pointerEvents: style.pointerEvents,
              layer: style.zIndex,
              contentOpacity: getComputedStyle(button).opacity,
              backingUnchanged: before === getComputedStyle(el).backgroundImage,
              controlFade: button.getAnimations().some(animation =>
                animation instanceof CSSTransition && animation.transitionProperty === 'background-color'),
            }
          } finally {
            for (const animation of animations) animation.finish()
          }
        }, fullscreen)
        expect(sample.endpoints).toEqual(fullscreen ? [0, 1] : [1, 0])
        expect(sample.duration).toBe(200)
        expect(sample.opacity).toBeGreaterThan(0)
        expect(sample.opacity).toBeLessThan(1)
        expect(sample.pointerEvents).toBe('none')
        expect(sample.layer).toBe('-1')
        expect(sample.contentOpacity).toBe('1')
        expect(sample.backingUnchanged).toBe(true)
        expect(sample.controlFade).toBe(true)
      }

      await page.emulateMedia({ reducedMotion: 'reduce' })
      for (const fullscreen of [true, false]) {
        const sample = await column.evaluate((el, fullscreen) => {
          document.documentElement.toggleAttribute('data-fullscreen', fullscreen)
          const opacity = getComputedStyle(el, '::before').opacity
          return {
            opacity,
            transitions: el.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSTransition).length,
          }
        }, fullscreen)
        expect(sample).toEqual({ opacity: fullscreen ? '1' : '0', transitions: 0 })
      }
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
