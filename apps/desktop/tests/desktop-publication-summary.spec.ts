import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { desktopPublicationSummary } from '../scripts/desktop-publication-summary.ts'
import type { DesktopRetainedSource } from '../scripts/desktop-release-store.ts'
import type { DesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'

const source: DesktopRetainedSource = {
  repository: 'owner/repo', runId: '20', attempt: '3', commit: 'a'.repeat(40), workflowCommit: 'b'.repeat(40),
  sourceRef: 'dsh-v1.0.0', channel: 'latest', runnerName: 'windows-publisher', target: 'win-x64',
  preset: 'production', productVersion: '1.0.0', version: '1.0.0', testReleaseId: null, qualification: 'signed',
}
const plan: DesktopUploadPlan = {
  environment: 'production', target: 'win-x64', version: '1.0.0', bucket: 'production-1234567890',
  publicUrl: 'https://download.example.com/dsh-desk/feeds/win-x64/', secretIdEnvName: 'SECRET_ID', secretKeyEnvName: 'SECRET_KEY',
  artifacts: [
    { path: '/not-read/installer.exe', filename: 'deepseek-harness-1.0.0-win-x64.exe', key: 'dsh-desk/bin/win-x64/latest/deepseek-harness-1.0.0-win-x64.exe',
      contents: 'installer bytes', contentType: 'application/octet-stream', channelMetadata: false },
    { path: '/not-read/latest.yml', filename: 'latest.yml', key: 'dsh-desk/feeds/win-x64/latest.yml',
      contents: 'version: 1.0.0\n', contentType: 'application/yaml', channelMetadata: true },
  ],
}

it('shows production destinations and tag after approval with upload-byte fingerprints', async () => {
  const summary = await desktopPublicationSummary(source, plan, 'c'.repeat(64))
  await expect(summary).toMatchFileSnapshot('./expected/publication-production.md')
  expect(summary).toContain('/latest/deepseek-harness-1.0.0-win-x64.exe')
  expect(summary).toContain('https&#58;//download.example.com/dsh-desk/feeds/win-x64/latest.yml')
  expect(summary).toContain(createHash('sha256').update('version: 1.0.0\n').digest('hex'))
  expect(summary).not.toContain('测试 release ID |')
  expect(summary).not.toContain('SECRET_KEY')
  expect(summary).not.toContain('/not-read/')
})

it('escapes runner display text without adding Markdown rows or HTML elements', async () => {
  const summary = await desktopPublicationSummary({ ...source, runnerName: 'runner|\n<script>`&"__win__![x](https://example.com/x.png)' }, plan, 'c'.repeat(64))
  expect(summary).toContain('runner&#124;&#10;&#60;script&#62;&#96;&#38;&#34;')
  expect(summary).not.toContain('<script>')
  expect(summary).toContain('&#95;&#95;win&#95;&#95;&#33;&#91;x&#93;&#40;https&#58;//example.com/x.png&#41;')
})

it('fails instead of rendering success when an upload file cannot be read', async () => {
  await expect(desktopPublicationSummary(source, { ...plan,
    artifacts: [{ path: '/missing-desktop-summary-artifact/installer.exe', filename: 'installer.exe',
      key: 'installer.exe', contentType: 'application/octet-stream', channelMetadata: false }],
  }, 'c'.repeat(64))).rejects.toThrow()
})
