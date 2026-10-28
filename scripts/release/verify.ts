/**
 * Verify a release family's version baseline, and — when publishing — that the
 * run comes from the family's tag and its members are publishable.
 *
 * Publication happens only from GitHub Actions. Publishability is mandatory;
 * tag validation may be explicitly bypassed with `--skip-tag-check`
 * ([rationale](../../.agents/notes/implemented/process/2026-08-10-npm-release-sequences.md)).
 */

import { parseArgs } from 'node:util'
import { isEntry } from './process.ts'
import { releaseFamily, type PublishPlan, type ReleaseFamily, type ReleaseMember } from './families.ts'

/**
 * Print the publish order the release will follow, and the peer declarations it
 * leaves unordered.
 *
 * The order is the release's own plan: an interrupted publication leaves exactly
 * a prefix of it, so reading it is how anyone judges what a partial run left on
 * the registry, and printing it on every pull request is what makes a change to
 * the order reviewable rather than only observable during a publication.
 * @param family - the release family.
 * @param plan - the resolved order and its dropped edges.
 */
function reportPublishOrder(family: ReleaseFamily, plan: PublishPlan): void {
  console.log(`release verify: publish order for family ${family.id}, ${String(plan.order.length)} member(s):`)
  const width = String(plan.order.length).length
  for (const [index, member] of plan.order.entries()) {
    console.log(`  ${String(index + 1).padStart(width, ' ')}  ${member.name}@${member.version}`)
  }
  if (plan.droppedPeerEdges.length === 0) return
  console.log(
    `release verify: ${String(plan.droppedPeerEdges.length)} peer declaration(s) publish unordered,`
    + ' because the peer cannot precede the package declaring it without contradicting a dependency edge'
    + ' or its own cycle. npm treats an unmet peer as a warning, so this orders nothing and blocks nothing:',
  )
  for (const edge of plan.droppedPeerEdges) console.log(`  ${edge.consumer} -> ${edge.peer}`)
}

/**
 * Assert every member may be published: npm refuses a `private` package.
 * @param members - the family's members.
 */
function verifyPublishable(members: readonly ReleaseMember[]): void {
  const priv = members.filter(member => member.manifest.private === true)
  if (priv.length > 0) {
    throw new Error(`publishing requires removing "private": true from:\n${priv.map(member => member.directory).join('\n')}`)
  }
}

/**
 * Assert the workflow runs from a tag this family publishes from, and that the
 * tag names a version the family actually carries.
 * @param family - the release family.
 * @param members - the family's members.
 * @param ref - the `GITHUB_REF` value.
 */
function verifyTag(family: ReleaseFamily, members: readonly ReleaseMember[], ref: string): void {
  const prefix = 'refs/tags/'
  if (!ref.startsWith(prefix)) {
    throw new Error(`publishing release family ${family.id} requires running from a ${family.tagPrefix}* tag, got ${ref || '(no ref)'}`)
  }
  const tag = ref.slice(prefix.length)
  if (!tag.startsWith(family.tagPrefix)) {
    throw new Error(`tag ${tag} does not belong to release family ${family.id} (expected ${family.tagPrefix}*)`)
  }
  const expected = members.map(member => family.tagFor(member))
  if (!expected.includes(tag)) {
    throw new Error(`tag ${tag} names no version this family carries; its members would tag as:\n${[...new Set(expected)].join('\n')}`)
  }
}

/** Run the verification for the family named by `--family`. */
function main(): void {
  const { values } = parseArgs({
    options: {
      family: { type: 'string' },
      'skip-tag-check': { type: 'boolean', default: false },
    },
    allowPositionals: false,
  })
  if (values.family === undefined) throw new Error('usage: verify.ts --family <dsh|vendor>')

  const family = releaseFamily(values.family)
  const members = family.members(process.cwd())
  family.verifyVersions(members)
  // Resolve the publish order here, before the build: an install-edge cycle
  // makes the order unrepresentable, and that has to surface at the first gate
  // rather than when pack is already writing tarballs.
  const plan = family.publishOrder(members)
  if (plan.order.length !== members.length) {
    throw new Error(
      `release family ${family.id}: publish order covers ${String(plan.order.length)} of ${String(members.length)} members`,
    )
  }
  reportPublishOrder(family, plan)

  const publishing = process.env.RELEASE_PUBLISH === 'true'
  if (publishing) {
    verifyPublishable(members)
    if (values['skip-tag-check']) {
      console.warn(`release verify: WARNING tag validation explicitly skipped for ref ${process.env.GITHUB_REF || '(no ref)'}`)
    } else {
      verifyTag(family, members, process.env.GITHUB_REF ?? '')
    }
  }

  const versions = [...new Set(members.map(member => member.version))]
  const summary = versions.length === 1 ? versions[0] : `${String(versions.length)} versions`
  console.log(
    `release verify: family ${family.id}, ${String(members.length)} member(s), ${summary},`
    + ` publish order resolved, ${String(plan.droppedPeerEdges.length)} peer declaration(s) unordered`
    + (publishing ? ', publish gates passed' : ''),
  )
}

if (isEntry(import.meta.url)) main()
