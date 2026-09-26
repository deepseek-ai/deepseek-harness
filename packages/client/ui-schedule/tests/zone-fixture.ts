/**
 * Zone fixtures for the ui-schedule client specs.
 *
 * A case that needs "a zone other than the runner's own" cannot pick one by name:
 * two IANA names can hold the same offset at the instant a case formats, so the
 * task-zone render would print the same wall clock as the browser-zone render.
 * A runner in `America/Toronto` formats `America/New_York`'s sample instant
 * identically, which is how such a case fails on some hosts only.
 */

/**
 * Candidate fixture zones.
 *
 * Several entries share an offset with each other at any one instant
 * (`Asia/Shanghai` with `Asia/Taipei`, `America/New_York` with `America/Toronto`,
 * `Europe/Berlin` with `Europe/Paris`), so a fixture that selects by name is not
 * guaranteed to differ from the runner's zone.
 */
const CANDIDATE_ZONES: readonly string[] = [
  'Asia/Shanghai', 'Asia/Taipei', 'America/New_York', 'America/Toronto',
  'Europe/Berlin', 'Europe/Paris', 'Pacific/Auckland', 'UTC',
]

/**
 * Offset of one zone at one instant, in whole minutes east of UTC.
 * @param timeZone - IANA zone name.
 * @param instant - ISO instant to read the offset at.
 * @returns minutes the zone's wall clock is ahead of UTC at that instant.
 */
export function zoneOffsetMinutes(timeZone: string, instant: string): number {
  const read = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(instant)).map(part => [part.type, part.value]))
  const wallClock = Date.UTC(
    Number(read['year']), Number(read['month']) - 1, Number(read['day']),
    Number(read['hour']), Number(read['minute']), Number(read['second']),
  )
  return (wallClock - Date.parse(instant)) / 60_000
}

/**
 * First fixture zone whose offset at one instant differs from another zone's.
 *
 * The comparison is by offset at the instant the case formats, never by name: a
 * zone the runner's own zone merely shares a name-independent offset with would
 * render the same wall clock and make a "task zone versus browser zone" case pass
 * without distinguishing anything.
 * @param instant - ISO instant the fixture formats.
 * @param deviceZone - zone to differ from; defaults to the runner's own zone.
 * @returns a candidate zone whose offset differs at that instant.
 * @throws Error when no candidate zone differs at that instant, so the fixture
 * fails with its reason instead of comparing a wall clock with itself.
 */
export function zoneDifferingFrom(
  instant: string,
  deviceZone: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): string {
  const deviceOffset = zoneOffsetMinutes(deviceZone, instant)
  const chosen = CANDIDATE_ZONES.find(zone => zoneOffsetMinutes(zone, instant) !== deviceOffset)
  if (chosen === undefined) {
    throw new Error(`No fixture zone differs from ${deviceZone} at ${instant}; add one to CANDIDATE_ZONES.`)
  }
  return chosen
}
