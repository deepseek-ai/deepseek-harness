import { MINUTE_MS, minuteAt } from '../policy.ts'

/**
 * One aligned clock per plugin registration; late background timers resync to the next minute.
 * @param update - receiver of each new minute.
 * @returns cleanup that stops the clock.
 */
export function startMinuteClock(update: (time: number) => void): () => void {
  const tick = () => {
    update(minuteAt(Date.now()))
    timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS))
  }
  let timer = setTimeout(tick, MINUTE_MS - (Date.now() % MINUTE_MS))
  return () => { clearTimeout(timer) }
}
