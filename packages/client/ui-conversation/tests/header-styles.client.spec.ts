/** Conversation navigation spacing preserves the right-pane header alignment. */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/client/skeleton/ConversationRoot.module.css', import.meta.url), 'utf8')

describe('conversation header geometry', () => {
  it('keeps the single-line header at the shared 76px height', () => {
    expect(css.match(/\.header\s*\{([^}]*)\}/)?.[1]).toContain('min-height: 76px')
    expect(css.match(/\.viewTabs\s*\{([^}]*)\}/)?.[1]).toContain('min-height: 25px')
    expect(css.match(/\.tab\s*\{([^}]*)\}/)?.[1]).toContain('min-height: 25px')
    expect(css.match(/\.tab\s*\{([^}]*)\}/)?.[1]).toContain('padding: 0 0 9px')
  })

  it('uses 32px between view labels without changing the action gap', () => {
    expect(css.match(/\.viewTabs\s*\{([^}]*)\}/)?.[1]).toContain('gap: 32px')
    expect(css.match(/\.tabs\s*\{([^}]*)\}/)?.[1]).toContain('gap: 16px 20px')
  })
})
