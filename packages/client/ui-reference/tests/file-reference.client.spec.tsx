// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { FileReference, FolderReference } from '../src/client/FileReference.tsx'
import { en } from '../src/client/locales.ts'

afterEach(cleanup)

type Props = ComponentProps<typeof FileReference>

function props(openFile: Props['openFile']): Props {
  return {
    node: { id: 'file', start: 0, end: 14, data: { path: 'docs/a b.md', label: 'a b.md' } },
    raw: '@"docs/a b.md"', interactive: true, openFile, t: makeTranslate(en),
  } as Props
}

describe('FileReference', () => {
  it('opens the decoded path and leaves summaries and folders non-interactive', () => {
    const openFile = vi.fn()
    const input = props(openFile)
    const view = render(<FileReference {...input} />)
    fireEvent.click(view.getByRole('button', { name: 'a b.md' }))
    expect(openFile).toHaveBeenCalledWith('docs/a b.md')
    expect(view.queryByRole('dialog')).toBeNull()
    view.rerender(<FileReference {...input} interactive={false} />)
    expect(view.getByText('a b.md').getAttribute('title')).toBe('@"docs/a b.md"')
    expect(view.queryByRole('button')).toBeNull()
    view.rerender(<FolderReference {...input} node={{
      id: 'folder', start: 0, end: 6, data: { path: 'docs/', label: 'docs' },
    }} raw="@docs/" />)
    expect(view.getByText('docs').getAttribute('title')).toBe('@docs/')
    expect(view.queryByRole('button')).toBeNull()
  })

  it('keeps a navigation failure local and retries or closes without losing the reference', () => {
    const openFile = vi.fn()
      .mockImplementationOnce(() => { throw new Error('unavailable') })
      .mockImplementationOnce(() => { throw new Error('still unavailable') })
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => { throw new Error('unavailable again') })
    const view = render(<FileReference {...props(openFile)} />)
    fireEvent.click(view.getByRole('button', { name: 'a b.md' }))
    expect(view.getByRole('dialog', { name: 'Couldn’t open file' }).textContent).toContain('Couldn’t open “docs/a b.md”')
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    expect(view.getByRole('dialog')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: 'Retry' }))
    expect(view.queryByRole('dialog')).toBeNull()
    expect(openFile.mock.calls).toEqual([['docs/a b.md'], ['docs/a b.md'], ['docs/a b.md']])
    fireEvent.click(view.getByRole('button', { name: 'a b.md' }))
    fireEvent.click(view.getAllByRole('button', { name: 'Close' }).at(-1)!)
    expect(view.queryByRole('dialog')).toBeNull()
    expect(view.getByRole('button', { name: 'a b.md' })).toBeTruthy()
  })
})
