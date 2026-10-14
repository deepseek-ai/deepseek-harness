/** Require four complete, same-commit executable reports before publishing release assets. */
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { z } from 'zod'
import { artifactManifestSchema, fileDigest, runtimeReportSchema, SSH_HELPER_TARGETS, verifyPayload, type ArtifactManifest } from './artifact.ts'
import { extractHelper } from '../verify-ssh-helper-artifact.ts'

const reportSchema = z.object({
  manifest: artifactManifestSchema,
  runtime: runtimeReportSchema,
  restrictedWorker: z.boolean().optional(), expectedBackend: z.string().nullable().optional(), glibc: z.string().optional(),
  readonlyInstall: z.boolean().optional(), concurrentColdStarts: z.number().optional(),
}).strict()
const coreChecks = ['executable-handshake', 'guarded-files-and-streams', 'managed-process-output', 'process-cancellation', 'native-pty', 'native-flock', 'embedded-ptc-and-deadline']

async function report(path: string, manifest: ArtifactManifest, checks: readonly string[]) {
  const evidence = reportSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  assert.deepEqual(evidence.manifest, manifest, `Report metadata differs: ${path}`)
  assert.equal(evidence.runtime.nodeVersion, manifest.nodeVersion)
  assert.equal(evidence.runtime.platform, manifest.target.includes('-linux-') ? 'linux' : 'darwin')
  for (const check of [...coreChecks, ...checks]) assert(evidence.runtime.checks.includes(check), `Report ${path} lacks ${check}`)
  return evidence
}

/**
 * Validate archives and their required native and SSH evidence, then write the release checksum list.
 * @param directory - downloaded artifacts from one successful four-target workflow run.
 * @param version - version selected by the release tag.
 * @param commit - immutable source commit checked out by every build job.
 * @returns the exact archive and checksum files permitted for upload.
 */
export async function prepareSshRelease(directory: string, version: string, commit: string): Promise<string[]> {
  const temporary = await mkdtemp(join(tmpdir(), 'dsh-helper-release-'))
  const archives: string[] = []
  const sums: string[] = []
  try {
    for (const target of SSH_HELPER_TARGETS) {
      const archive = join(directory, `dsh-ssh-helper-${version}-${target.slice('node24-'.length)}.tar.gz`)
      const digest = await fileDigest(archive)
      assert.equal(digest, (await readFile(`${archive}.sha256`, 'utf8')).split(/\s/)[0])
      const destination = join(temporary, target)
      await mkdir(destination)
      const manifest = await verifyPayload(await extractHelper(archive, destination))
      assert.equal(manifest.target, target)
      assert.equal(manifest.version, version)
      assert.equal(manifest.commit, commit)
      assert.equal(manifest.dirty, false, 'Release artifacts must come from a clean source checkout')
      const native = await report(join(directory, `${target}.json`), manifest, ['sandbox-enforcement'])
      assert.equal(native.runtime.sandboxLane, 'required')
      assert.equal(native.readonlyInstall, true)
      assert.equal(native.concurrentColdStarts, 2)
      if (target.includes('-macos-')) assert.equal(native.restrictedWorker, true)
      else {
        const ssh = await report(join(directory, `${target}.ssh.json`), manifest, ['target-has-no-node'])
        assert.equal(ssh.glibc, 'glibc 2.28')
        const landlock = await report(join(directory, `${target}.landlock.json`), manifest, ['sandbox-enforcement'])
        assert.equal(landlock.expectedBackend, 'landlock-run')
        assert.equal(landlock.runtime.sandboxLane, 'required')
      }
      archives.push(archive)
      sums.push(`${digest}  ${basename(archive)}`)
    }
    const checksums = join(directory, 'SHA256SUMS')
    await writeFile(checksums, `${sums.join('\n')}\n`)
    return [...archives, checksums]
  } finally { await rm(temporary, { recursive: true, force: true }) }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { directory: { type: 'string' }, version: { type: 'string' }, commit: { type: 'string' } } })
  if (values.directory === undefined || values.version === undefined || values.commit === undefined) throw new Error('Release verification requires --directory, --version and --commit')
  console.log((await prepareSshRelease(resolve(values.directory), values.version, values.commit)).join('\n'))
}
