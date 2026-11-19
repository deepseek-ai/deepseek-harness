// @vitest-environment jsdom
/** The document body Factory's dispatch by implementation id and its unavailable-renderer line. */
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import type { UseSidebarRightTabInfo } from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import { DocumentViewer } from '../src/client/content/ContentPreview.tsx'
import type { DocumentBodyInput } from '../src/client/document/contract.ts'
import type { DocumentPreviewDefinition } from '../src/client/document/registry.ts'
import { ADDRESS, t } from './fixtures.client.ts'

type Props = FactoryComponentPropsOf<'sidebar.right.document.body'>

afterEach(cleanup)

const useTabInfo = vi.fn<UseSidebarRightTabInfo>()
const viewer: DocumentPreviewDefinition = { id: 'viewer', extensions: ['md'], title: () => 'Viewer', loading: 'text-pages' }

function input(overrides: Partial<DocumentBodyInput> = {}): DocumentBodyInput {
  return {
    rendererId: viewer.id, useTabInfo, resourceAddress: ADDRESS,
    content: { kind: 'text', text: 'body', pages: [], eof: true },
    wrap: false, scrollportRef: vi.fn(), addResource: vi.fn(), setResources: vi.fn(),
    ...overrides,
  }
}

/** Render the Factory with a body-slot double that honors the fallback only when `registered` is false. */
type BodySlot = (key: string, owner: object, options: { entryKey: string; hookContext: unknown; fallback: ReactNode }) => ReactNode

function renderBody(value: DocumentBodyInput, registered: boolean, definitions: readonly DocumentPreviewDefinition[] = [viewer]) {
  const renderSlot = vi.fn<BodySlot>(
    (_key, _owner, options) => registered ? <p data-body={options.entryKey} /> : options.fallback,
  )
  const props = {
    ...value, renderSlot, t,
    useDocumentPreviews: <S,>(select: (snapshot: readonly DocumentPreviewDefinition[]) => S): S => select(definitions),
  } as Props
  return { view: render(<DocumentViewer {...props} />), renderSlot }
}

describe('document body Factory', () => {
  it('dispatches the owner inputs to the body registered under the implementation id', () => {
    const scrollportRef = vi.fn()
    const { view, renderSlot } = renderBody(input({ baseAddress: ADDRESS, scrollportRef }), true)
    expect(view.container.querySelector('[data-body]')?.getAttribute('data-body')).toBe(viewer.id)
    const [key, owner, options] = renderSlot.mock.calls[0]!
    expect(key).toBe('sidebar.right.tab.document')
    const callback: unknown = expect.any(Function)
    expect(owner).toEqual({
      resourceAddress: ADDRESS, baseAddress: ADDRESS, content: { kind: 'text', text: 'body', pages: [], eof: true },
      wrap: false, scrollportRef, addResource: callback, setResources: callback,
    })
    expect(options).toMatchObject({ entryKey: viewer.id, hookContext: useTabInfo })
  })

  it('omits the base address from the owner inputs of content without one', () => {
    const { renderSlot } = renderBody(input(), true)
    expect(renderSlot.mock.calls[0]![1]).not.toHaveProperty('baseAddress')
  })

  it('names an unavailable renderer by its definition title, or by its id once the definition is gone', () => {
    const titled = renderBody(input(), false)
    expect(titled.view.container.textContent).toBe('rendererUnavailable(name=Viewer)')
    titled.view.unmount()
    const orphan = renderBody(input({ rendererId: 'removed' }), false)
    expect(orphan.view.container.textContent).toBe('rendererUnavailable(name=removed)')
  })
})
