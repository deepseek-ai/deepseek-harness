/**
 * Pack one release family's whole publish set into a single directory and
 * record its publish order for the publish step. Default serial packs execute
 * in that order; explicitly parallel packs use pnpm's bounded scheduler.
 *
 * The pack step is the release boundary: it runs without credentials, produces
 * every tarball from one commit, and hands the publish step exactly those bytes
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { pnpmInvocation } from '../pnpm-invocation.ts'
import { releaseFamily, tarballName, type ReleaseFamily, type ReleaseMember } from './families.ts'
import { isEntry, runConcurrent } from './process.ts'
import { PUBLISH_ORDER_FILE, packedManifest, tarballFiles } from './tarball.ts'

/** Where pack output lands when `--out` is omitted. */
const DEFAULT_OUTPUT = 'dist/npm'

/**
 * Check one member's expected tarball and its published files.
 * @param family - the release family being packed.
 * @param member - the member to pack.
 * @param destination - absolute output directory.
 * @returns The tarball filename.
 */
function validatePackedMember(family: ReleaseFamily, member: ReleaseMember, destination: string): string {
  const filename = tarballName(member)
  const tarball = join(destination, filename)
  if (!existsSync(tarball)) throw new Error(`${member.name} produced no tarball at ${tarball}`)
  family.validatePayload(member, tarballFiles(tarball))
  family.validatePackedManifest(member, packedManifest(tarball))
  return filename
}

/**
 * Pack serial members in publish order, or batch an explicitly parallel family.
 * @param family - Release family whose payload checks apply to every tarball.
 * @param members - Exact public members in the recorded publish order.
 * @param destination - Absolute output directory.
 * @param concurrency - Maximum active package packs; one preserves serial publication order.
 * @returns Validated tarball filenames in publish order.
 */
async function packMembers(
  family: ReleaseFamily, members: readonly ReleaseMember[], destination: string, concurrency: number,
): Promise<string[]> {
  if (concurrency === 1) {
    const order: string[] = []
    for (const member of members) {
      const invocation = pnpmInvocation(['--dir', member.directory, 'pack', '--pack-destination', destination])
      await runConcurrent(invocation.command, invocation.args)
      order.push(validatePackedMember(family, member, destination))
    }
    return order
  }
  if (members.length === 0) return []
  const invocation = pnpmInvocation([
    'pack',
    '--recursive',
    `--workspace-concurrency=${String(concurrency)}`,
    ...members.map(member => `--filter=${member.name}`),
    '--pack-destination', destination,
  ])
  await runConcurrent(invocation.command, invocation.args)
  return members.map(member => validatePackedMember(family, member, destination))
}

/**
 * @returns The validated `--concurrency` value; 1 (the default) packs the
 * members one at a time, exactly as the credentialed publish workflows run it.
 */
function parseConcurrency(raw: string | undefined): number {
  if (raw === undefined) return 1
  const parsed = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || String(parsed) !== raw) {
    throw new Error(`--concurrency must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  return parsed
}

/** Pack the family named by `--family` into `--out`. */
async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { family: { type: 'string' }, out: { type: 'string' }, concurrency: { type: 'string' } },
    allowPositionals: false,
  })
  if (values.family === undefined) throw new Error('usage: pack.ts --family <dsh|vendor> [--out dist/npm] [--concurrency 1]')
  const concurrency = parseConcurrency(values.concurrency)

  const family = releaseFamily(values.family)
  const root = process.cwd()
  const destination = resolve(root, values.out ?? DEFAULT_OUTPUT)
  const members = family.publishOrder(family.members(root)).order
  family.verifyBuildArtifacts(root)
  family.verifyVersions(members)

  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })

  const order = await packMembers(family, members, destination, concurrency)
  writeFileSync(join(destination, PUBLISH_ORDER_FILE), `${order.join('\n')}\n`)

  console.log(`release pack: family ${family.id}, ${String(order.length)} tarball(s) in ${values.out ?? DEFAULT_OUTPUT}`)
}

if (isEntry(import.meta.url)) await main()
