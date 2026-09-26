// Disposes itself once active. The Loader treats a self-disposing entry as a
// config change and writes the tree back through `EntryTree.write()`, which is
// the exact path that once truncated a preset file to `[]`.
export const name = 'self-dispose'
export function apply(ctx) {
  globalThis.__SELF_DISPOSED__ = new Promise((resolve) => {
    setTimeout(() => { ctx.fiber.dispose(); resolve(undefined) }, 0)
  })
}
