// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import {
  DiffFenceLayer, MathFenceLayer, type DiffFenceLayerProps, type MathFenceLayerProps,
} from '../src/client/fence/FenceLayers.tsx'

const t = makeTranslate(zh, commonZh)

afterEach(() => {
  cleanup()
})

describe('Chat Markdown fence layers', () => {
  it('math layer shows the inner content while streaming', () => {
    const props = { lang: 'math', code: 'x^2', streaming: true } as MathFenceLayerProps
    const { container } = render(<MathFenceLayer {...props}><p data-testid="inner" /></MathFenceLayer>)
    expect(screen.getByTestId('inner')).toBeTruthy()
    expect(container.querySelector('.katex')).toBeNull()
  })

  it('math layer typesets the settled fence and drops the inner content', () => {
    const props = { lang: 'math', code: 'x^2', streaming: false } as MathFenceLayerProps
    const { container } = render(<MathFenceLayer {...props}><p data-testid="inner" /></MathFenceLayer>)
    expect(container.querySelector('.katex')).not.toBeNull()
    expect(screen.queryByTestId('inner')).toBeNull()
  })

  it('diff layer renders unified-diff rows', () => {
    const props = { lang: 'diff', code: '@@ -1 +1 @@\n-old\n+new', streaming: false, t } as DiffFenceLayerProps
    const { container } = render(<DiffFenceLayer {...props} />)
    expect(container.querySelector('pre')!.textContent).toBe('@@ -1 +1 @@\n-old\n+new')
    expect(container.querySelectorAll('[class*="_diffAdd_"]').length).toBe(1)
    expect(container.querySelectorAll('[class*="_diffDel_"]').length).toBe(1)
  })
})
