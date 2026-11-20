/** Native fullscreen material changes through the shipped sidebar composition. */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { expect, it } from 'vitest'
import { launchWebScaffold } from './scaffold.ts'

it.each(['light', 'dark'] as const)('fades the macOS fullscreen fill without fading content in %s mode', async (colorScheme) => {
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
          const root = document.documentElement
          root.toggleAttribute('data-fullscreen', fullscreen)
          getComputedStyle(el).getPropertyValue('--dsh-sidebar-fullscreen-fill')
          const animations = el.getAnimations({ subtree: true })
          const backing = animations.find(animation =>
            animation instanceof CSSTransition && animation.transitionProperty === '--dsh-sidebar-fullscreen-fill'
            && animation.effect instanceof KeyframeEffect && animation.effect.target === el)
          if (backing === undefined || !(backing.effect instanceof KeyframeEffect)) {
            throw new Error('Fullscreen fill transition is missing')
          }
          /** Alpha of a computed CSS color, read through a canvas so every color syntax resolves. */
          const alpha = (color: string): number => {
            const canvas = document.createElement('canvas').getContext('2d')!
            canvas.fillStyle = color
            canvas.fillRect(0, 0, 1, 1)
            return canvas.getImageData(0, 0, 1, 1).data[3]! / 255
          }
          try {
            for (const animation of animations) {
              animation.pause()
              animation.currentTime = Number(animation.effect!.getComputedTiming().duration) / 2
            }
            const style = getComputedStyle(el)
            const button = el.querySelector('[data-slot="sidebar.session.action"] button')!
            return {
              endpoints: backing.effect.getKeyframes().map(keyframe => alpha(String(keyframe['--dsh-sidebar-fullscreen-fill']))),
              duration: backing.effect.getComputedTiming().duration,
              alpha: alpha(style.getPropertyValue('--dsh-sidebar-fullscreen-fill')),
              position: style.position,
              isolation: style.isolation,
              contentOpacity: getComputedStyle(button).opacity,
              controlFade: button.getAnimations().some(animation =>
                animation instanceof CSSTransition && animation.transitionProperty === 'background-color'),
            }
          } finally {
            for (const animation of animations) animation.finish()
          }
        }, fullscreen)
        expect(sample.endpoints).toEqual(fullscreen ? [0, 1] : [1, 0])
        expect(sample.duration).toBe(200)
        expect(sample.alpha).toBeGreaterThan(0)
        expect(sample.alpha).toBeLessThan(1)
        // A positioned or isolated column would trap sidebar overlays below the centre column.
        expect(sample.position).toBe('static')
        expect(sample.isolation).toBe('auto')
        expect(sample.contentOpacity).toBe('1')
        expect(sample.controlFade).toBe(true)
      }

      await page.emulateMedia({ reducedMotion: 'reduce' })
      for (const fullscreen of [true, false]) {
        const sample = await column.evaluate((el, fullscreen) => {
          document.documentElement.toggleAttribute('data-fullscreen', fullscreen)
          return {
            fill: getComputedStyle(el).getPropertyValue('--dsh-sidebar-fullscreen-fill') !== 'rgba(0, 0, 0, 0)',
            transitions: el.getAnimations({ subtree: true }).filter(animation => animation instanceof CSSTransition).length,
          }
        }, fullscreen)
        expect(sample).toEqual({ fill: fullscreen, transitions: 0 })
      }
    } finally {
      await browser.close()
    }
  } finally {
    await scaffold.close()
  }
})
