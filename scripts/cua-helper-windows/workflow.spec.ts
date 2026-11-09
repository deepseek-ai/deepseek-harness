import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const workflow = readFileSync(new URL('../../.github/workflows/cua-helper-package-windows.yml', import.meta.url), 'utf8')

describe('Windows CUA helper workflow', () => {
  it('publishes self-contained metadata before archiving', () => {
    expect(workflow).toContain('--self-contained true')
    expect(workflow.indexOf('Add helper metadata')).toBeLessThan(workflow.indexOf('Archive publish output'))
    expect(workflow).toContain('cua-helper.json')
    expect(workflow).toContain('schemaVersion')
    expect(workflow).toContain('sourceDigest')
    expect(workflow).toContain('Verify helper archive')
  })

  it('names artifacts with the build key and avoids pull request triggers', () => {
    expect(workflow).toMatch(/name: cua-helper-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}-\$\{\{ steps\.metadata\.outputs\.build-key \}\}/u)
    expect(workflow).not.toContain('pull_request')
  })
})
