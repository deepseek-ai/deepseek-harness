import { timeTicks } from 'd3-time'
import { HISTORY_MS, MINUTE_MS } from '../policy.ts'

/** One linear wall-clock axis shared by every report column. */
export class TimeScale {
  private readonly start: number
  /** Full pixel height of the visible history window. */
  readonly height: number

  constructor(private readonly anchor: number, pixelsPerHour: number) {
    this.start = anchor - HISTORY_MS
    this.height = (HISTORY_MS / 3600000) * pixelsPerHour
  }

  private clampTime(time: number): number {
    return Math.max(this.start, Math.min(this.anchor, time))
  }

  /**
   * Map a wall clock timestamp to the shared vertical axis.
   * @param time - wall clock timestamp in milliseconds.
   * @returns vertical position in pixels.
   */
  position(time: number): number {
    return this.height * (1 - (this.clampTime(time) - this.start) / HISTORY_MS)
  }

  /**
   * Map a vertical offset back to wall clock time.
   * @param position - vertical offset in pixels.
   * @returns wall clock timestamp in milliseconds.
   */
  time(position: number): number {
    const fraction = position / this.height
    // Keep the interpolation order so rounding at calendar tick boundaries stays stable.
    return this.clampTime(this.anchor * (1 - fraction) + this.start * fraction)
  }

  /**
   * Keep the grid at minute resolution, including empty spans between reports.
   * @param top - first visible pixel on the axis.
   * @param height - visible height of the axis in pixels.
   * @param spacing - desired distance between tick labels in pixels.
   * @returns visible calendar ticks in time order.
   */
  ticks(top: number, height: number, spacing: number): Date[] {
    let previous = -Infinity
    return timeTicks(new Date(this.time(top)), new Date(this.time(top + height)), Math.max(1, height / spacing))
      .filter(value => Number(value) % MINUTE_MS === 0)
      .sort((a, b) => Number(b) - Number(a))
      .filter((value) => {
        const position = this.position(Number(value))
        if (position - previous < spacing * 0.65) return false
        previous = position
        return true
      })
  }
}
