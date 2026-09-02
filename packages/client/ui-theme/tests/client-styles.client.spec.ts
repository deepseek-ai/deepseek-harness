// @vitest-environment jsdom
/** Dynamic ui-theme entry owns the global styles in dependency order. */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { installThemeStyles } from '../src/client/styles.ts'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-theme'

afterEach(() => {
  document.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`).forEach((node) => { node.remove() })
})

describe('ui-theme client styles', () => {
  it('mounts every global sheet in dependency order and removes them on dispose', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({
      apply(scope) { installThemeStyles(scope) },
    })
    await fiber.await()

    const styles = [...document.head.querySelectorAll<HTMLStyleElement>(`style[data-plugin="${PLUGIN_ID}"]`)]
    expect(styles.map(style => style.dataset.pluginCss)).toEqual([
      `${PLUGIN_ID}/base.css`,
      `${PLUGIN_ID}/corner-shape.css`,
      `${PLUGIN_ID}/design-platform.css`,
      `${PLUGIN_ID}/scrollbar.css`,
      `${PLUGIN_ID}/gradient-shadow-text.css`,
      `${PLUGIN_ID}/shiki.css`,
    ])
    await fiber.dispose()
    expect(document.head.querySelectorAll(`style[data-plugin="${PLUGIN_ID}"]`)).toHaveLength(0)
  })
})
