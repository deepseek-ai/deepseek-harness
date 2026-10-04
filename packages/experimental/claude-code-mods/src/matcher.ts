/**
 * Event-name patterns and field matchers: which registered hooks an event
 * selects. Event names are Claude Code's; a hook on a name this bridge never
 * raises registers fine and never runs.
 * @module
 */

import type { HookMatcher, MatcherValue } from './types.ts'

/** The events the engine raises on its own, as opposed to the `<namespace>.<method>` events a mods API call raises. */
export const ENGINE_EVENTS: ReadonlySet<string> = new Set([
  'tool.call', 'tool.check', 'tool.describe',
  'prompt.submit', 'prompt.fill', 'prompt.suggest', 'prompt.edit', 'prompt.compose', 'prompt.section',
  'prompt.context', 'prompt.attachment', 'skill.prompt', 'attribution.text',
  'command.run', 'command.describe', 'config.set', 'config.describe',
  'turn.start', 'turn.step', 'turn.complete',
  'session.start', 'session.end', 'session.compact', 'session.receive', 'session.send', 'session.append',
  'session.attach', 'session.detach', 'session.measure',
  'agent.offer', 'agent.spawn',
  'ui.render', 'ui.resolve', 'ui.press', 'ui.input', 'ui.select', 'ui.focus', 'ui.scroll', 'ui.close', 'ui.message',
  'plugin.register', 'engine.create',
  'telemetry.log', 'telemetry.mark',
])

/**
 * Every event name a mod may hook, in Claude Code's reference order: engine
 * events, then every mods API method as `<namespace>.<method>`. `on` refuses a
 * name outside this list with Claude Code's own wording, so a misspelling
 * fails at load rather than registering a hook that never runs.
 */
export const KNOWN_EVENTS: ReadonlySet<string> = new Set([
  ...ENGINE_EVENTS,
  // mods API calls
  'ui.log', 'ui.toast', 'ui.status', 'ui.notice', 'ui.invalidate', 'ui.open', 'ui.panes', 'ui.blit', 'ui.ask', 'ui.copy',
  'command.register', 'command.list',
  'tool.register', 'tool.list',
  'agent.register', 'agent.list',
  'model.complete', 'model.fork', 'model.classify',
  'prompt.read',
  'turn.abort',
  'session.messages', 'session.cwd', 'session.root', 'session.model', 'session.turns', 'session.id', 'session.repo',
  'session.surface', 'session.surfaces', 'session.usage', 'session.version', 'session.authorize',
  'config.list',
  'settings.read',
  'env.get', 'env.set',
  'fs.read', 'fs.write', 'fs.list', 'fs.exists', 'fs.stat', 'fs.ancestors',
  'store.get', 'store.set', 'store.delete', 'store.keys',
  'state.get', 'state.set',
  'clock.now', 'clock.sleep', 'clock.after', 'clock.every',
  'http.fetch',
  'process.run', 'process.spawn',
  'mcp.call', 'mcp.connect',
  'audio.play', 'audio.speak',
])

/**
 * Whether a name passed to `on` is an exact event name, `*`, or a `<namespace>.*` glob.
 * @param pattern - the name or glob.
 * @returns true when `on` accepts it.
 */
export function isEventPattern(pattern: string): boolean {
  if (pattern === '*') return true
  if (pattern.endsWith('.*')) {
    const namespace = pattern.slice(0, -2)
    return namespace.length > 0 && [...KNOWN_EVENTS].some(event => event.startsWith(`${namespace}.`))
  }
  return KNOWN_EVENTS.has(pattern)
}

/**
 * Whether a registered pattern selects an event. `*` selects every event
 * except the telemetry ones, which a mod hooks by name or as `telemetry.*`.
 * @param pattern - the name or glob passed to `on`.
 * @param event - the event being raised.
 * @returns true when the pattern selects the event.
 */
export function eventMatches(pattern: string, event: string): boolean {
  if (pattern === event) return true
  if (pattern === '*') return !event.startsWith('telemetry.')
  return pattern.endsWith('.*') && event.startsWith(pattern.slice(0, -1))
}

function valueMatches(expected: MatcherValue, actual: unknown): boolean {
  if (expected instanceof RegExp) {
    // A global or sticky expression remembers where its last test stopped; every event starts fresh.
    expected.lastIndex = 0
    return (typeof actual === 'string' || typeof actual === 'number') && expected.test(String(actual))
  }
  if (Array.isArray(expected)) return expected.some(candidate => candidate === actual)
  return expected === actual
}

/**
 * Whether every matcher field accepts the event's top-level field of the same
 * name: a scalar by equality, an array by membership, a RegExp by test.
 * @param matcher - the matcher passed to `on`.
 * @param input - the event input as this hook would receive it.
 * @returns true when the hook should run.
 */
export function matcherMatches(matcher: HookMatcher, input: unknown): boolean {
  if (typeof input !== 'object' || input === null) return false
  const record = input as Record<string, unknown>
  return Object.entries(matcher).every(([field, expected]) => valueMatches(expected, record[field]))
}

/**
 * Render a matcher the way `claude plugin validate` prints it.
 * @param matcher - the matcher, or undefined for a hook without one.
 * @returns `{field=value,...}`, or an empty string.
 */
export function describeMatcher(matcher: HookMatcher | undefined): string {
  if (matcher === undefined) return ''
  const fields = Object.entries(matcher).map(([field, value]) => {
    const rendered = value instanceof RegExp ? String(value) : Array.isArray(value) ? value.join('|') : String(value)
    return `${field}=${rendered}`
  })
  return `{${fields.join(',')}}`
}
