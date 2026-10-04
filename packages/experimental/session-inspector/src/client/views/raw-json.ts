/** JSON inspection of live objects, including cyclic Location stores. */

class InspectorJsonWriter {
  private readonly ancestors: object[] = []
  private readonly containers = new WeakMap<object, object>()

  write(value: unknown): string {
    const replace = this.replace.bind(this)
    const result: unknown = JSON.stringify(value, function (this: object, _key, item: unknown) {
      return replace(this, item)
    }, 2)
    return typeof result === 'string' ? result : ''
  }

  private replace(parent: object, value: unknown): unknown {
    if (typeof value === 'bigint') return `${value}n`
    if (value === null || typeof value !== 'object') return value
    while (this.ancestors.length > 0 && this.ancestors.at(-1) !== parent) this.ancestors.pop()
    let rendered = value
    if (value instanceof Map || value instanceof Set) {
      const container: object = this.containers.get(value)
        ?? (value instanceof Map ? Object.fromEntries<unknown>(value) : [...value])
      this.containers.set(value, container)
      rendered = container
    }
    // Only ancestors are circular; sibling references retain their complete values.
    if (this.ancestors.includes(rendered)) return '[Circular]'
    this.ancestors.push(rendered)
    return rendered
  }
}

/**
 * Serialize raw details without allowing a formatting failure to retire the View.
 * @param value - Original record; Maps/Sets become objects/arrays and bigint becomes an n-suffixed string.
 * @returns JSON with circular references marked, or an error message for the detail panel.
 */
export function inspectorJson(value: unknown): { readonly text: string; readonly failed: boolean } {
  try {
    return { text: new InspectorJsonWriter().write(value), failed: false }
  } catch (error) {
    return { text: error instanceof Error ? error.message : String(error), failed: true }
  }
}
