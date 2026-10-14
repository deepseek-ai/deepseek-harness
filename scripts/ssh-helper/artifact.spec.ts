import { cp, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { create as createTar } from 'tar'
import { expect, it, onTestFinished } from 'vitest'
import { artifactManifestSchema, fileDigest, payloadFiles, SSH_HELPER_TARGETS, verifyPayload } from './artifact.ts'
import { macosDeploymentVersions } from './native.ts'
import { extractHelper } from '../verify-ssh-helper-artifact.ts'
import { prepareSshRelease } from './release.ts'

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-helper-archive-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const payload = join(root, 'dsh-ssh-helper')
  await mkdir(join(payload, 'native/system'), { recursive: true })
  await writeFile(join(payload, 'dsh-ssh-helper'), 'fixture executable')
  await writeFile(join(payload, 'native/system/package.json'), '{}')
  const metadata = {
    format: 1, version: '1.0.0', commit: 'a'.repeat(40), dirty: false,
    target: 'node24-linux-x64', protocol: 2, nodeVersion: 'v24.1.0',
    files: await Promise.all((await payloadFiles(payload)).map(async path => ({
      path, sha256: await fileDigest(join(payload, path)), mode: (await lstat(join(payload, path))).mode & 0o777,
    }))),
  }
  const save = async () => { await writeFile(join(payload, 'manifest.json'), JSON.stringify(metadata)) }
  await save()
  return { root, payload, metadata, save }
}

it('validates the exact unpacked inventory and rejects altered bytes', async () => {
  const test = await fixture()
  expect(await verifyPayload(test.payload)).toEqual(test.metadata)
  await writeFile(join(test.payload, 'dsh-ssh-helper'), 'changed executable')
  await expect(verifyPayload(test.payload)).rejects.toThrow('digest differs')
})

it('rejects missing, undeclared and duplicate payload files', async () => {
  const test = await fixture()
  await writeFile(join(test.payload, 'undeclared'), '')
  await expect(verifyPayload(test.payload)).rejects.toThrow('inventory')
  await rm(join(test.payload, 'undeclared'))
  test.metadata.files.push(test.metadata.files[0]!)
  await test.save()
  await expect(verifyPayload(test.payload)).rejects.toThrow('inventory')
  test.metadata.files.pop()
  await test.save()
  await rm(join(test.payload, 'native/system/package.json'))
  await expect(verifyPayload(test.payload)).rejects.toThrow('inventory')
})

it.each(['../outside', '/absolute', 'a/../b', 'a\\b', 'a//b'])('rejects unsafe manifest path %s', async (path) => {
  const test = await fixture()
  expect(() => artifactManifestSchema.parse({ ...test.metadata, files: [{ ...test.metadata.files[0], path }] })).toThrow('payload path')
})

it.skipIf(process.platform === 'win32')('rejects links before extracting an archive', async () => {
  const test = await fixture()
  await symlink('/etc/passwd', join(test.payload, 'outside'))
  await expect(payloadFiles(test.payload)).rejects.toThrow('symbolic link')
  const archive = join(test.root, 'linked.tar.gz')
  await createTar({ cwd: test.root, file: archive, gzip: true }, ['dsh-ssh-helper'])
  const extracted = join(test.root, 'unpack')
  await mkdir(extracted)
  await expect(extractHelper(archive, extracted)).rejects.toThrow('Invalid SSH helper archive entry')
})

it('extracts and verifies a portable archive in a new directory', async () => {
  const test = await fixture()
  const archive = join(test.root, 'helper.tar.gz')
  await createTar({ cwd: test.root, file: archive, gzip: true, portable: true }, ['dsh-ssh-helper'])
  const extracted = join(test.root, 'relocated')
  await mkdir(extracted)
  const directory = await extractHelper(archive, extracted)
  expect(dirname(directory)).toBe(extracted)
  expect(await verifyPayload(directory)).toEqual(test.metadata)
  expect(await readFile(join(directory, 'dsh-ssh-helper'), 'utf8')).toBe('fixture executable')
})

it('reads minimum macOS versions without accepting a linked library version as the OS version', () => {
  expect(macosDeploymentVersions('Load command 0\ncmd LC_VERSION_MIN_MACOSX\nversion 11.0\nLoad command 1\ncmd LC_LOAD_DYLIB\ncurrent version 1311.100.3\nLoad command 2\ncmd LC_BUILD_VERSION\nminos 14.0\nsdk 15.1\n'))
    .toEqual(['11.0', '14.0'])
  expect(macosDeploymentVersions('Load command 0\ncmd LC_LOAD_DYLIB\ncurrent version 14.0\n')).toEqual([])
})

it('publishes only a complete clean-source matrix with native and no-Node evidence', async () => {
  const test = await fixture()
  const archives = join(test.root, 'release')
  await mkdir(archives)
  const checks = ['executable-handshake', 'guarded-files-and-streams', 'managed-process-output', 'process-cancellation', 'native-pty', 'native-flock', 'embedded-ptc-and-deadline', 'sandbox-enforcement']
  for (const target of SSH_HELPER_TARGETS) {
    const parent = join(test.root, target)
    await mkdir(parent)
    const payload = join(parent, 'dsh-ssh-helper')
    await cp(test.payload, payload, { recursive: true })
    const manifest = { ...test.metadata, target }
    await writeFile(join(payload, 'manifest.json'), JSON.stringify(manifest))
    const archive = join(archives, `dsh-ssh-helper-1.0.0-${target.slice('node24-'.length)}.tar.gz`)
    await createTar({ cwd: parent, file: archive, gzip: true, portable: true }, ['dsh-ssh-helper'])
    await writeFile(`${archive}.sha256`, `${await fileDigest(archive)}  archive\n`)
    const runtime = { checks, nodeVersion: 'v24.1.0', platform: target.includes('linux') ? 'linux' : 'darwin', sandboxLane: 'required' }
    await writeFile(join(archives, `${target}.json`), JSON.stringify({ manifest, runtime, restrictedWorker: true, readonlyInstall: true, concurrentColdStarts: 2 }))
    if (target.includes('linux')) {
      await writeFile(join(archives, `${target}.ssh.json`), JSON.stringify({ manifest, runtime: { ...runtime, checks: [...checks, 'target-has-no-node'], sandboxLane: 'portable' }, glibc: 'glibc 2.28' }))
      await writeFile(join(archives, `${target}.landlock.json`), JSON.stringify({ manifest, runtime, expectedBackend: 'landlock-run' }))
    }
  }
  expect(await prepareSshRelease(archives, '1.0.0', test.metadata.commit)).toHaveLength(5)
  expect((await readFile(join(archives, 'SHA256SUMS'), 'utf8')).trim().split('\n')).toHaveLength(4)
  await expect(prepareSshRelease(archives, '1.0.0', 'b'.repeat(40))).rejects.toThrow()
  const report = join(archives, 'node24-linux-x64.ssh.json')
  const evidence = JSON.parse(await readFile(report, 'utf8')) as { runtime: { checks: string[] } }
  evidence.runtime.checks = evidence.runtime.checks.filter(check => check !== 'target-has-no-node')
  await writeFile(report, JSON.stringify(evidence))
  await expect(prepareSshRelease(archives, '1.0.0', test.metadata.commit)).rejects.toThrow('lacks target-has-no-node')
  await rm(report)
  await expect(prepareSshRelease(archives, '1.0.0', test.metadata.commit)).rejects.toThrow('ENOENT')
})
