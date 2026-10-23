/** Conversation navigation spacing preserves the right-pane header alignment. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url), 'utf8')

describe('conversation header geometry', () => {
  it('keeps the single-line header at the shared 76px height', () => {
    expect(css.match(/\.header\s*\{([^}]*)\}/)?.[1]).toContain('min-height: 76px')
    expect(css.match(/\.viewTabs\s*\{([^}]*)\}/)?.[1]).toContain('min-height: 25px')
    // The tab's 35px press target sits 10px above its 25px row through a negative top margin.
    expect(css.match(/\.tab\s*\{([^}]*)\}/)?.[1]).toContain('min-height: 35px')
    expect(css.match(/\.tab\s*\{([^}]*)\}/)?.[1]).toContain('margin: -10px calc(-1 * var(--dsh-tab-hit-inline)) 0')
    expect(css.match(/\.tab\s*\{([^}]*)\}/)?.[1]).toContain('padding: 10px var(--dsh-tab-hit-inline) 9px')
  })

  it('uses 32px between view labels without changing the action gap', () => {
    expect(css.match(/\.viewTabs\s*\{([^}]*)\}/)?.[1]).toContain('gap: 32px')
    expect(css.match(/\.tabs\s*\{([^}]*)\}/)?.[1]).toContain('gap: 16px 20px')
  })
})
