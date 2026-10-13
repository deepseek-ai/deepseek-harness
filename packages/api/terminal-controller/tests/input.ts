/** A typed uplink whose return interrupts a pending read, matching Gateway invocation cleanup. */
export function inputChannel<T>() {
  let controller!: ReadableStreamDefaultController<T>
  const stream = new ReadableStream<T>({ start(value) { controller = value } })
  const reader = stream.getReader()
  const source: AsyncIterable<T> = {
    [Symbol.asyncIterator]: () => ({
      async next() {
        const result = await reader.read()
        return result.done ? { done: true, value: undefined } : { done: false, value: result.value }
      },
      async return() { await reader.cancel(); return { done: true, value: undefined } },
    }),
  }
  return { source, push: (value: T) => { controller.enqueue(value) }, end: () => { controller.close() } }
}
