// @vitest-environment jsdom
/** The owner's display name used by the attribution line, and its durable fallbacks. */

import { createElement } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  forgetOwnerDisplay, rememberOwnerDisplay, rememberOwnerIdentity,
} from '../src/client/owner-display.ts'
import { SharedSessionOrigin } from '../src/client/user-origin.tsx'

afterEach(() => {
  cleanup()
  forgetOwnerDisplay()
})

const SOURCE = {
  kind: 'user',
  rpcId: 'rpc-shared',
  principal: {
    kind: 'share-viewer',
    shareId: 'share-1',
    actor: { providerId: 'relay', tenantId: 'tenant', subjectId: 'subject-42' },
  },
}

const t = ((_key: string, params?: { readonly subjectId?: string }) => params?.subjectId ?? '') as never

/** Render the attribution line for one share-viewer source. */
function attribution(): HTMLElement {
  const props = { source: SOURCE, kind: 'user', matched: { subjectId: 'subject-42' }, t } as never
  const view = render(createElement(SharedSessionOrigin, props))
  return view.container
}

/** One identity read the face performs on mount. */
function sharesWithIdentity(answer: () => Promise<unknown>): never {
  return { identity: answer } as never
}

describe('owner display', () => {
  it('shows the owner name for the owner own subject and falls back otherwise', () => {
    rememberOwnerDisplay({ subjectId: 'subject-42', displayName: '许翰翔' })
    expect(attribution().textContent).toBe('许翰翔')
    expect(attribution().querySelector('[data-liveshare-origin="subject-42"]')).not.toBeNull()
    // Repeating the same facts does not create a second store update, and clearing restores the id.
    rememberOwnerDisplay({ subjectId: 'subject-42', displayName: '许翰翔' })
    forgetOwnerDisplay()
    expect(attribution().textContent).toBe('subject-42')
  })

  it('records a verified identity, and clears on a refusal or an unverified answer', async () => {
    await expect(rememberOwnerIdentity(sharesWithIdentity(async () => ({
      ok: true, value: { state: 'verified', relay: '', displayName: '许翰翔', subjectId: 'subject-42' },
    })))).resolves.toBeUndefined()
    expect(attribution().textContent).toBe('许翰翔')

    await rememberOwnerIdentity(sharesWithIdentity(async () => ({ ok: false, error: { code: 'x' } })))
    expect(attribution().textContent).toBe('subject-42')

    rememberOwnerDisplay({ subjectId: 'subject-42', displayName: '许翰翔' })
    await rememberOwnerIdentity(sharesWithIdentity(async () => ({ ok: true, value: { state: 'unverified', relay: '' } })))
    expect(attribution().textContent).toBe('subject-42')
  })

  it('leaves an absent read and a throwing read as the durable subject id', async () => {
    await expect(rememberOwnerIdentity({} as never)).resolves.toBeUndefined()
    await expect(rememberOwnerIdentity(sharesWithIdentity(async () => { throw new Error('offline') })))
      .resolves.toBeUndefined()
    expect(attribution().textContent).toBe('subject-42')
  })
})
