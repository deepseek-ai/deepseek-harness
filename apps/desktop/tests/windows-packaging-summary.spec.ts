/** Workflow summaries distinguish requested options from completed build evidence. */
import { execFile } from 'node:child_process'
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { windowsPackagingSummary } from '../scripts/windows-packaging-summary.mjs'

it('separates workflow identity, requested source, and resolved build version', () => {
  const summary = windowsPackagingSummary({
    PACKAGE_SOURCE_REF: 'feature/windows', PACKAGE_SOURCE_SHA: 'source-sha',
    GITHUB_WORKFLOW_REF: 'repo/.github/workflows/windows-package.yml@refs/heads/master',
    GITHUB_WORKFLOW_SHA: 'workflow-sha', PACKAGE_INPUT_VERSION_MODE: 'default',
    PACKAGE_VERSION: '0.2.2-rc.1.20261110.1.1', PACKAGE_SIGNING: 'signed',
    DSH_PACKAGING_PRESET: 'test', DSH_DESKTOP_UPDATE_CHANNEL: 'nightly',
  })
  expect(summary).toContain('| 源码 ref | <code>feature/windows</code> |')
  expect(summary).toContain('| 检出源码 SHA | <code>source-sha</code> |')
  expect(summary).toContain('| 工作流 SHA | <code>workflow-sha</code> |')
  expect(summary).toContain('| 版本模式 | <code>default</code> |')
  expect(summary).toContain('| 解析后的版本号 | <code>0.2.2-rc.1.20261110.1.1</code> |')
  expect(summary).toContain('不代表构建、签名或发布成功')
})

it('retains unresolved and machine-default labels after an earlier failure', () => {
  const summary = windowsPackagingSummary({ PACKAGE_SOURCE_REF: 'bad-source' })
  expect(summary).toContain('| 检出源码 SHA | 尚未取得 |')
  expect(summary).toContain('| 解析后的版本号 | 尚未解析成功 |')
  expect(summary).toContain('使用机器默认值（本摘要不读取）')
  expect(summary).toContain('| 缓存命名空间 | 共享缓存 |')
})

it('escapes input markup and excludes unrelated environment and private configuration', () => {
  const summary = windowsPackagingSummary({
    PACKAGE_SOURCE_REF: '<script>|\n[link](url)`',
    DSH_DESKTOP_WINDOWS_TOKEN_PIN: 'private-pin-sentinel',
    DSH_PACKAGING_CONFIG_DIR: 'private-directory-sentinel',
  })
  expect(summary).toContain('&#60;script&#62;&#124;&#10;&#91;link&#93;&#40;url&#41;&#96;')
  expect(summary).not.toContain('<script>')
  expect(summary).not.toContain('sentinel')
})

it('appends a summary using the standalone workflow helper without project dependencies', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'windows-summary-'))
  t.onTestFinished(() => rm(root, { recursive: true, force: true }))
  const output = join(root, 'summary.md')
  const helper = join(root, 'windows-packaging-summary.mjs')
  await copyFile(join(import.meta.dirname, '../scripts/windows-packaging-summary.mjs'), helper)
  await writeFile(output, 'Previous summary\n')
  await promisify(execFile)(process.execPath, [helper], {
    env: { GITHUB_STEP_SUMMARY: output, PACKAGE_SOURCE_REF: 'test-ref', PACKAGE_SIGNING: 'unsigned' },
    timeout: 20_000,
  })
  expect(await readFile(output, 'utf8')).toMatch(/^Previous summary\n/u)
  expect(await readFile(output, 'utf8')).toContain('| 签名方式（请求） | <code>unsigned</code> |')
})
