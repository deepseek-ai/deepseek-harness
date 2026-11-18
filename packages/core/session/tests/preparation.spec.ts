import { describe, expect, it, vi } from 'vitest'
import { Session, type SessionId, SessionPreparation } from '@deepseek-ai/dsh-session'
import { brandString } from '@deepseek-ai/dsh-brand'

describe('SessionPreparation', () => {
  it('retains the exact Session and releases provider state only once', () => {
    const session = Session.create(brandString<SessionId>('prepared'))
    const release = vi.fn()
    {
      using preparation = SessionPreparation.create(session, { release })
      expect(preparation.session).toBe(session)
      preparation[Symbol.dispose]()
      expect(release).toHaveBeenCalledOnce()
    }
    expect(release).toHaveBeenCalledOnce()
  })

  it('disposes a preparation without provider state', () => {
    using preparation = SessionPreparation.create(Session.create(brandString<SessionId>('unretained')))
    expect(() => { preparation[Symbol.dispose]() }).not.toThrow()
  })
})
