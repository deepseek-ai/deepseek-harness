/** Workspace-local CUA bridge used by recorded initialization templates. */
import { unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Prepare an equivalent bridge at a workspace-owned URL and remove it when the fixture closes. */
export async function installCuaBridge(ctx) {
  const bridge = join(process.cwd(), 'cua-bridge.mjs')
  const face = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib/bridge.js' : 'src/bridge.ts'
  const source = new URL('../../../packages/experimental/cua/' + face, import.meta.url).href
  await writeFile(bridge, `export { connectCua } from ${JSON.stringify(source)}\n`)
  ctx.effect(() => () => unlink(bridge))
  const installedBridge = JSON.stringify(new URL('../../../packages/experimental/cua/lib/bridge.js', import.meta.url).href)
  ctx.on('system-prompt/assemble', async (assembly, _context, next) => {
    for (const section of assembly.sections) {
      if (section.name === 'computer-use:dsh-cua') {
        section.text = section.text.replace(installedBridge, JSON.stringify(pathToFileURL(bridge).href))
      }
    }
    return next()
  })
}
