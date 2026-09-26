/** Node-half coverage for the model guidance paired with Web file references. */

import { readFile } from 'node:fs/promises'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { apply, inject } from '../src/index.ts'

let ctx: Context | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
})

describe('ui-deliverables node plugin', () => {
  it('registers final-response file-reference guidance only while mounted', async () => {
    ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: '' })
    ctx.provide('connection', { fetch: { register: () => () => {} } } as never)
    ctx.provide('sessionQuery', {} as never)
    ctx.provide('sessionController', {} as never)
    ctx.provide('workspaceFiles', {} as never)
    ctx.provide('fs', {} as never)
    ctx.provide('sandboxPolicy', {} as never)
    ctx.provide('workspaceChanges', {} as never)
    const mounted = ctx.plugin({ apply, inject })
    await mounted.await()

    const section = (await ctx.systemPrompt.assemble()).sections
      .find(entry => entry.name === 'ui:deliverable-file-references')
    expect(section?.text).toMatchInlineSnapshot('"Prefer showing the primary results within your final response alongside a brief explanation. Use ![Description](<path/to/image.png>) when an image supports an explanation or comparison. Use [Description](<path/to/image.png>) when referring to an image or listing files. Enclose Markdown file destinations in angle brackets, especially paths containing spaces. Do not call present just to list edited source files, or run commands to check whether a diff view will appear. Use present when a separate file card helps the user open the complete deliverable, including images, Office documents, spreadsheets, and slide decks. Each presented file adds a card below the reply, with preview and native-open actions. Avoid repeating results already shown inline unless the separate card adds useful access. Outside commands, configuration expressions, and code blocks, link every mention of an existing file, including repeats and tables, to its full path relative to the working directory or absolute; append #L24 or #L24-L30 to the target for known lines. Use the filename or a clear alias as the label, adding only enough parent directories to distinguish files; keep full paths out of labels. Default to the name alone; when precise locations matter, append :24 or :24–30, with no # or L in the line suffix."')

    // Only live request pins track current guidance; seeded sessions retain their recorded prompt.
    for (const scenario of ['fresh-round-trip', 'ptc-round']) {
      const sidecar = await readFile(new URL(`../../../../snapshots/web/${scenario}/system-prompt.expected.md`, import.meta.url), 'utf8')
      expect(sidecar, scenario).toContain(section!.text)
    }

    await mounted.dispose()
    expect((await ctx.systemPrompt.assemble()).sections
      .some(entry => entry.name === 'ui:deliverable-file-references')).toBe(false)
  })
})
