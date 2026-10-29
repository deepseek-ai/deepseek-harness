/** Real CUA prompt registration without native operations in the Script replay. */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { CuaConfig } from '@deepseek-ai/dsh-cua'

export const name = 'cua-script-guidance'
export const inject = ['computerUse', 'tools', 'systemPrompt', 'subprocess', 'agents']
export const Config = CuaConfig

export async function apply(ctx, config) {
  const root = join(process.cwd(), 'cua-runtime')
  // The snapshot launcher validates and propagates the selected program mode.
  const face = process.env.DSH_EXAMPLE_MODE === 'lib' ? 'lib' : 'src'
  const extension = face === 'lib' ? 'js' : 'ts'
  const { installCua } = await import(pathToFileURL(join(root, face, `index.${extension}`)).href)
  const { GUIDANCE } = await import(pathToFileURL(join(root, `guidance.${extension}`)).href)
  installCua(ctx, config, {
    helperPath: process.execPath,
    createChannel() { throw new Error('This prompt fixture does not perform native operations') },
    guidance: GUIDANCE,
    description: 'Inspect applications through the CUA object runtime.',
  })
}
