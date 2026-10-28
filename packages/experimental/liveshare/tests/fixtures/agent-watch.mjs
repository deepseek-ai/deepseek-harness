/**
 * Test-only observer for agent publication in one isolated acceptance instance.
 *
 * It subscribes to the harness's own lifecycle events and appends one line per occurrence to the file
 * `BASE_AGENT_WATCH` names, so a case can state whether an agent was published without reading queue
 * or job keys, and without any product code knowing this observer exists.
 */

import { appendFileSync } from 'node:fs'

/** Whether the injected failure has already been spent. */
let failedOnce = false

/** Record one line, when this run asked for a record. */
function note(line) {
  const target = process.env.BASE_AGENT_WATCH
  // A recorder that cannot write must fail loudly: an unwritable watch file would otherwise look
  // exactly like a run in which nothing was published.
  if (!target) throw new Error('agent-watch: BASE_AGENT_WATCH is not set for this instance')
  // Negative control: one deliberate write failure proves the driver reports instrument error rather
  // than reading the resulting silence as "nothing was published".
  if (process.env.AGENT_WATCH_FAIL_ONCE === '1' && !failedOnce) {
    failedOnce = true
    process.stderr.write(`agent-watch: write failed for ${target}: injected for the negative control\n`)
    throw new Error('agent-watch: injected write failure')
  }
  try {
    appendFileSync(target, `${line}\n`)
  } catch (error) {
    // The registry swallows listener exceptions and logs a warning, so a thrown error alone cannot be
    // told apart from "nothing happened". This marker is what the driver asserts on; it does not change
    // the registry's own exception isolation.
    process.stderr.write(`agent-watch: write failed for ${target}: ${String(error)}\n`)
    throw error
  }
}

/** Cordis plugin name. */
export const name = 'acceptance-agent-watch'

/**
 * Subscribe to publication and lifecycle events.
 * @param {object} ctx - Cordis context of this isolated instance.
 */
export function apply(ctx) {
  note('watch-loaded')
  // Both scoped and root carriers are subscribed: the harness emits publication on the entry's own
  // carrier, so a root listener alone would miss it.
  ctx.on('agent/created', (payload) => { note(`created ${String(payload?.agent?.id)}`) })
  ctx.on('agent/disposed', (payload) => { note(`disposed ${String(payload?.agent?.id)}`) })
  ctx.on('agent/status', (payload) => {
    note(`status ${String(payload?.agent?.id)} ${String(payload?.status)}`)
  })
  // No setup-entry observer here: reading the registry through `ctx.get('agents')` from this plugin did
  // not bind (no `inject`, and the host registers its step independently), so an "entry" line would have
  // been absent whether or not the installer ran. Publication is observed for real, below and above.
}
