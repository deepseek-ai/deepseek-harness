/** Shared assertions for original-build routing and artifact identity in packaging workflows. */
import { expect } from 'vitest'

/**
 * Require archival steps to retain the original machine, directory and build identity.
 * @param job Parsed archival job from a packaging workflow.
 * @param count Expected number of artifact upload steps.
 * @returns The checked upload steps, preserving platform-specific fields.
 */
export function expectDesktopArchive<S extends { uses?: string; with?: Record<string, unknown> }>(
  job: { 'runs-on': string | string[]; env: Record<string, string>; steps: S[] }, count: number,
): S[] {
  expect(job['runs-on']).toEqual(['self-hosted', '${{ needs.package.outputs.runner }}'])
  expect(job.env).toMatchObject({
    DESKTOP_RETAINED_DIRECTORY: '${{ needs.package.outputs.directory }}',
    DESKTOP_PACKAGE_ATTEMPT: '${{ needs.package.outputs.attempt }}',
    DESKTOP_PACKAGE_RUNNER: '${{ needs.package.outputs.runner-name }}',
  })
  const uploads = job.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
  expect(uploads).toHaveLength(count)
  for (const step of uploads) {
    expect(step.with?.name).toBe('${{ env.DESKTOP_ARCHIVE_NAME }}')
    expect(job.env.DESKTOP_ARCHIVE_NAME).toContain('${{ needs.package.outputs.version }}')
    expect(job.env.DESKTOP_ARCHIVE_NAME).toContain('${{ needs.package.outputs.attempt }}')
    expect(job.env.DESKTOP_ARCHIVE_NAME).not.toContain('github.run_attempt')
  }
  return uploads
}
