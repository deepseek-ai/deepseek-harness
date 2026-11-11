/** Host half of the forge extension fixture: a filter lens that keeps the files whose new side has `export` lines, about those lines. */
export const name = '@fixture/forge-extension'
export const inject = ['forgePanel']

/** @param {import('@deepseek-ai/cordis').Context} ctx */
export function apply(ctx) {
  ctx.forgePanel.registerLens({
    id: 'fixture/exports',
    version: '1',
    async classify(input, signal) {
      const files = {}
      let done = 0
      for (const file of input.files) {
        const text = await input.text('new', file.path, signal)
        done += 1
        input.progress(done, input.files.length)
        if (text === null) continue
        const ranges = []
        text.split('\n').forEach((line, index) => {
          if (/^export\b/.test(line)) ranges.push({ start: index + 1, end: index + 1 })
        })
        if (ranges.length > 0) files[file.path] = { ranges: { old: [], new: ranges } }
      }
      return { files }
    },
  })
}
