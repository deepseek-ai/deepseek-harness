import { describe, expect, it } from 'vitest'
import type { SessionFormatArtifact, SessionFormatHeader } from '@deepseek-ai/dsh-session-format'
import {
  validateInstalledCurrentSessionArtifact,
  validateInstalledCurrentSessionHeader,
} from '../src/current.ts'

const currentHeader: SessionFormatHeader = {
  version: 2,
  id: 'installed-current',
  createdAt: 1,
  isSeeded: false,
  delegationDepth: 0,
}

describe('installed current Session restoration', () => {
  it('rejects version skew before entering current Session validation', () => {
    expect(() => { validateInstalledCurrentSessionHeader({ ...currentHeader, version: 0 }) })
      .toThrow(/installed Session format is v2, got v0/)
    const artifact: SessionFormatArtifact = {
      header: { ...currentHeader, version: 0 },
      inheritedEventCount: 0,
      events: [],
    }
    expect(() => { validateInstalledCurrentSessionArtifact(artifact) })
      .toThrow(/installed Session format is v2, got v0/)
  })

  it('accepts only current request-header reasons and the true starts-series marker', () => {
    const artifact = (reason: string, startsSeries?: boolean): SessionFormatArtifact => ({
      header: { ...currentHeader },
      inheritedEventCount: 0,
      events: [
        { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
        {
          type: 'request/header', seq: 1, time: 2,
          data: {
            header: { config: { provider: 'mock', model: 'mock' } },
            reason,
            ...(startsSeries === undefined ? {} : { startsSeries }),
          },
        },
      ],
    })

    expect(() => { validateInstalledCurrentSessionArtifact(artifact('fallback')) })
      .toThrow(/request\/header.*reason/)
    expect(() => { validateInstalledCurrentSessionArtifact(artifact('initial', false)) })
      .toThrow(/startsSeries/)
    expect(() => { validateInstalledCurrentSessionArtifact(artifact('series', true)) }).not.toThrow()
  })
})
