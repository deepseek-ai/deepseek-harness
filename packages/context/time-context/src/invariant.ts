/** Package-owned durable clock-context invariants. @module @deepseek-ai/dsh-time-context/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import {
  deriveBrowserTimeZoneContext,
  renderBrowserTimeZoneContext,
} from './request-zone.ts'
import { createTimestampFormatter, formatTimestamp } from './timestamp.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-time-context'
const SOURCE_NAME = 'time-context'
const READING = new RegExp(
  '^Time sampled while preparing turn (\\d+), step (\\d+): '
  + '(\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:Z|[+-]\\d{2}:\\d{2})\\[[^\\]]+\\])\\n'
  + '(Browser time zone for this request: .+)\\n'
  + 'Elapsed since the preceding (model-visible message|step context): '
  + '(?:unavailable|(?:(?:\\d+d )?(?:\\d+h )?(?:\\d+m )?\\d+s))\\.$',
)

/** Cordis companion plugin name. */
export const name = 'time-context-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Derive the open step boundary at which a time-context reading may append. */
function preparationPosition(history: readonly SessionEvent[], fail: InvariantFailure): { turn: number; step: number } {
  let openTurn: number | undefined
  let openStep: number | undefined
  let requestStarted = false
  for (const event of history) {
    switch (event.type) {
      case 'turn/start': {
        openTurn = event.data.turn
        openStep = undefined
        requestStarted = false
        break
      }
      case 'step/start': {
        openStep = event.data.step
        requestStarted = false
        break
      }
      case 'request/header': {
        requestStarted = true
        break
      }
      case 'step/end': {
        openStep = undefined
        requestStarted = false
        break
      }
      case 'turn/end': {
        openTurn = undefined
        openStep = undefined
        requestStarted = false
        break
      }
      default:
        break
    }
  }
  if (openTurn === undefined) fail('time-context reading must be appended inside an open turn')
  if (openStep === undefined) fail('time-context reading must follow step/start')
  if (requestStarted) fail('time-context reading must precede request/header')
  return { turn: openTurn, step: openStep }
}

/** Collect the entered user messages belonging to one open turn. */
function requestMessages(history: readonly SessionEvent[], turn: number) {
  const start = history.findLastIndex(event => event.type === 'turn/start' && event.data.turn === turn)
  return history.slice(start + 1)
    .flatMap(event => event.type === 'user/message' ? [event.data] : [])
}

/** Validate one plugin-attributed time reading against its session position and timestamp. */
function validateReading(
  history: readonly SessionEvent[],
  event: SessionEvent<'user/message'>,
  fail: InvariantFailure,
): void {
  const blockValue: unknown = event.data.content[0]
  const block = typeof blockValue === 'object' && blockValue !== null
    ? blockValue as Record<string, unknown>
    : undefined
  const blockText = block?.text
  if (event.data.content.length !== 1
    || block === undefined
    || Object.keys(block).length !== 2
    || block.type !== 'text'
    || typeof blockText !== 'string') {
    fail('time-context messages must contain exactly one text block')
  }
  const match = READING.exec(blockText)
  if (match === null) fail('time-context message does not match the durable reading format')
  const turn = Number(match[1])
  const step = Number(match[2])
  if (!Number.isSafeInteger(turn) || turn < 1 || !Number.isSafeInteger(step) || step < 1) {
    fail('time-context turn and step must be positive safe integers')
  }
  const expected = preparationPosition(history, fail)
  if (turn !== expected.turn || step !== expected.step) {
    fail(`time-context reading names turn ${turn}/step ${step}, expected turn ${expected.turn}/step ${expected.step}`)
  }
  const source = event.data.source
  /* v8 ignore next 2 -- replay and dispatch callers select this exact package-owned source before validation. */
  if (source.kind !== 'plugin' || source.plugin !== SOURCE_NAME) {
    fail('time-context source must retain package ownership')
  }
  const sections: unknown = 'sections' in source ? source.sections : undefined
  const sectionValue: unknown = Array.isArray(sections) ? sections[0] : undefined
  const section = typeof sectionValue === 'object' && sectionValue !== null
    ? sectionValue as Record<string, unknown>
    : undefined
  if (Object.keys(source).length !== 4
    || source.form !== 'snapshot'
    || !Array.isArray(sections)
    || sections.length !== 1
    || section === undefined
    || Object.keys(section).length !== 2
    || section.name !== SOURCE_NAME
    || section.text !== blockText) {
    fail('time-context source must carry only the exact snapshot text, not request authority')
  }
  const renderedBrowserContext = match[4]
  const browserContext = deriveBrowserTimeZoneContext(requestMessages(history, turn))
  const expectedBrowserContext = renderBrowserTimeZoneContext(browserContext)
  if (renderedBrowserContext !== expectedBrowserContext) {
    fail('time-context browser-zone text does not match current-turn user messages')
  }
  const baseline = match[5]
  if ((step === 1) !== (baseline === 'model-visible message')) {
    fail(`time-context step ${step} uses the wrong elapsed-time baseline ${JSON.stringify(baseline)}`)
  }
  const rendered = match[3]
  /* v8 ignore next -- the preceding fixed regexp always supplies capture group three. */
  if (rendered === undefined) fail('time-context reading omitted its rendered timestamp')
  const renderedTime = Date.parse(rendered.replace(/\[[^\]]+\]$/, ''))
  if (!Number.isFinite(renderedTime) || !Number.isSafeInteger(event.time)
    || event.time < renderedTime) {
    fail('time-context rendered timestamp must parse and not postdate its durable event')
  }
  if (browserContext.kind === 'resolved') {
    let expectedTimestamp: string
    try {
      expectedTimestamp = formatTimestamp(
        renderedTime,
        createTimestampFormatter(browserContext.timeZone),
        browserContext.timeZone,
      )
    } catch (error: unknown) {
      fail(`time-context browser zone cannot format its durable timestamp: ${String(error)}`)
    }
    if (rendered !== expectedTimestamp) {
      fail('time-context rendered timestamp does not match the unique browser zone')
    }
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate all package-owned readings already present in one session. */
function validateSession(session: Session, fail: InvariantFailure): void {
  const events = session.snapshotEvents()
  for (const [index, event] of events.entries()) {
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) continue
    validateReading(events.slice(0, index), event, fail)
  }
}

/** Install validation for loaded and newly appended context readings. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  for (const session of ctx.sessions.list()) validateSession(session, fail)
  ctx.on('session/created', (session) => { validateSession(session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    if (event.type !== 'user/message'
      || event.data.source.kind !== 'plugin'
      || event.data.source.plugin !== SOURCE_NAME) return
    validateReading(session.snapshotEvents(), event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the time-context invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
