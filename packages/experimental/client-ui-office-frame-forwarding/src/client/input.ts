/** Ordered native input with at most one unsent pointer position between discrete events. */
interface Work {
  run: () => Promise<unknown>
  reject: (error: Error) => void
  motion: boolean
}

/** Preserve clicks, keys, and save barriers while replacing obsolete pointer positions. */
export class OfficeInput {
  private readonly queue: Work[] = []
  private running = false

  /**
   * Queue an input or a barrier behind all previously received inputs.
   * @param run - Native operation, or an empty async operation to settle input.
   * @returns Completion of this operation.
   */
  send<T>(run: () => Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        run: async () => {
          resolve(await run())
        },
        reject,
        motion: false,
      })
      void this.drain()
    })
  }

  /**
   * Replace only a trailing unsent motion; discrete events retain their order.
   * @param run - Latest native pointer position.
   * @param reject - Reports an input failure.
   */
  move(run: () => Promise<unknown>, reject: (error: Error) => void): void {
    const last = this.queue.at(-1)
    if (last?.motion) {
      last.run = run
      last.reject = reject
    } else this.queue.push({ run, reject, motion: true })
    void this.drain()
  }

  private async drain(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      for (let work = this.queue.shift(); work !== undefined; work = this.queue.shift()) {
        try {
          await work.run()
        } catch (error) {
          work.reject(error instanceof Error ? error : new Error(String(error)))
        }
      }
    } finally {
      this.running = false
    }
  }
}
