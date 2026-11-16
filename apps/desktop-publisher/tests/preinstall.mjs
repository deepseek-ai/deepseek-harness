/** Exercise the pre-install entrypoints in a fixture with no workspace dependency links. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFile, mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const directory = await realpath(await mkdtemp(join(tmpdir(), 'publisher-preinstall-')))
try {
  for (const filename of ['preflight-desktop-publish.mjs', 'preflight-desktop-publish-local.mjs', 'desktop-publish-qualification.mjs']) {
    await copyFile(new URL(`../src/${filename}`, import.meta.url), join(directory, filename))
  }
  const { preflightDesktopPublish } = await import(pathToFileURL(join(directory, 'preflight-desktop-publish.mjs')).href)
  assert.equal(preflightDesktopPublish('owner/repo', { package_run_id: '123', package_run_attempt: '2' }, () => [{ artifacts: [] }]), '2')
  assert.throws(() => preflightDesktopPublish('owner/repo', { package_run_id: '123', package_run_attempt: '2' }, () => [{ artifacts: [{ name: 'windows-x64-unsigned-123-2' }] }]), /unsigned/)
  const env = { ...process.env }
  for (const key of ['GITHUB_EVENT_PATH', 'GITHUB_REPOSITORY', 'GITHUB_OUTPUT', 'DSH_PACKAGING_CONFIG_DIR', 'NODE_OPTIONS']) Reflect.deleteProperty(env, key)
  for (const [filename, diagnostic] of [
    ['preflight-desktop-publish.mjs', 'Actions context required'],
    ['preflight-desktop-publish-local.mjs', 'set DSH_PACKAGING_CONFIG_DIR'],
  ]) {
    const result = spawnSync(process.execPath, [join(directory, filename)], { env, encoding: 'utf8', timeout: 10_000 })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.ok(result.stderr.includes(diagnostic), result.stderr)
    assert.ok(!result.stderr.includes('ERR_MODULE_NOT_FOUND'), result.stderr)
  }
  console.log('Desktop publisher pre-install entrypoints: OK')
} finally {
  await rm(directory, { recursive: true, force: true })
}
