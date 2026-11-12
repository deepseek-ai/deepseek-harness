import { expect, it } from 'vitest'
import { preflightDesktopPublish } from '@deepseek-ai/dsh-desktop-publisher/preflight-desktop-publish.mjs'

it.each([
  ['macos-x64-unnotarized-debug-1.0.0-42-2', '跳过了公证'],
  ['macos-arm64-unnotarized-debug-1.0.0-42-2', '跳过了公证'],
  ['macos-arm64-unnotarized-debug-1.0.0-42-2.zip', '跳过了公证'],
  ...['arm64', 'x64'].flatMap(arch => ['.dmg', '-update.zip', '-metadata.zip'].map(suffix =>
    [`macos-${arch}-unnotarized-debug-1.0.0-42-2${suffix}`, '跳过了公证'])),
  ['windows-x64-unsigned-1.0.0-42-2.zip', '未签名'],
  ['windows-x64-unsigned-1.0.0-42-2', '未签名'],
])('rejects %s from paginated artifact metadata with rebuilding instructions', (name, reason) => {
  const paths: string[] = []
  expect(() => preflightDesktopPublish('owner/repo', { package_run_id: '42' }, (path, paginate) => {
    paths.push(path)
    if (!paginate) return { run_attempt: 2 }
    return [{ artifacts: [] }, { artifacts: [{ name, expired: true }] }]
  })).toThrow(reason)
  expect(paths).toEqual(['repos/owner/repo/actions/runs/42', 'repos/owner/repo/actions/runs/42/artifacts?per_page=100'])
})

it.each([{ artifacts: [] }, { artifacts: [{ name: 'windows-x64-signed-1.0.0-42-2' }] }, { artifacts: [{ name: 'windows-x64-unsigned-1.0.0-42-1' }] }])(
  'leaves missing metadata and other attempts to authoritative local verification: %j', ({ artifacts }) => {
    expect(preflightDesktopPublish('owner/repo', { package_run_id: '42', package_run_attempt: '2' }, (path, paginate) => {
      expect(paginate).toBe(true)
      expect(path).toContain('/42/artifacts?')
      return [{ artifacts }]
    })).toBe('2')
  },
)

it('rejects malformed input before contacting GitHub', () => {
  expect(() => preflightDesktopPublish('owner/repo', { package_run_id: '../42' }, () => {
    throw new Error('API must not be called')
  })).toThrow(/valid packaging attempt/u)
})

it.each([{ response: {} }, { response: [{ artifacts: [{}] }] }])('rejects invalid artifact responses: %j', ({ response }) => {
  expect(() => preflightDesktopPublish('owner/repo', { package_run_id: '42', package_run_attempt: '2' }, () => response))
    .toThrow(/invalid artifact metadata/u)
})

it.each(['arm64', 'x64'])('accepts notarized split %s artifacts and ignores debugging artifacts from other attempts', (arch) => {
  const artifacts = ['.dmg', '-update.zip', '-metadata.zip'].flatMap(suffix => [
    { name: `macos-${arch}-signed-1.0.0-42-2${suffix}` },
    { name: `macos-${arch}-unnotarized-debug-1.0.0-42-1${suffix}` },
    { name: `macos-${arch}-unnotarized-debug-1.0.0-142-2${suffix}` },
  ])
  expect(preflightDesktopPublish('owner/repo', { package_run_id: '42', package_run_attempt: '2' }, () => [{ artifacts }])).toBe('2')
})
