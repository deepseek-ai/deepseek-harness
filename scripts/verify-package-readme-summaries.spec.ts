import { describe, expect, it } from 'vitest'
import {
  MAX_PACKAGE_README_SUMMARY_WORDS,
  packageReadmeSummaryErrors,
} from './verify-package-readme-summaries.ts'

function readme(summary: string, kind = 'package-reference'): string {
  return `---\nkind: "${kind}"\n---\n# Example\n\n## Summary\n\n${summary}\n\n## Table of Contents\n`
}

describe('package README Summary limit', () => {
  it('accepts exactly 100 whitespace-delimited words', () => {
    const summary = Array.from({ length: MAX_PACKAGE_README_SUMMARY_WORDS }, () => 'word').join(' ')

    expect(packageReadmeSummaryErrors('packages/example/example/README.md', readme(summary))).toEqual([])
  })

  it.each([
    'package-group',
    'package-reference',
    'package-library',
    'package-bundle',
  ])('rejects 101 words and directs the author to the skill and %s template', (kind) => {
    const summary = Array.from({ length: MAX_PACKAGE_README_SUMMARY_WORDS + 1 }, () => 'word').join(' ')

    expect(packageReadmeSummaryErrors('packages/example/example/README.md', readme(summary, kind))).toEqual([
      `packages/example/example/README.md: Summary has 101 words; the limit is 100. Read .agents/skills/dsh-doc/SKILL.md and .agents/skills/dsh-doc/templates/${kind}.md before rewriting it.`,
    ])
  })

  it('counts only the Summary body', () => {
    const laterSection = Array.from({ length: 101 }, () => 'detail').join(' ')

    expect(packageReadmeSummaryErrors(
      'packages/example/example/README.md',
      `${readme('Short summary.')}\n${laterSection}`,
    )).toEqual([])
  })

  it('rejects a missing Summary instead of silently narrowing the corpus', () => {
    expect(packageReadmeSummaryErrors(
      'packages/example/example/README.md',
      '---\nkind: "package-reference"\n---\n# Example\n',
    )).toEqual(['packages/example/example/README.md: missing `## Summary`'])
  })
})
