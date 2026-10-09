/** Unversioned file plugins do not block Loader-composed DeepSeek requests. */
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import DeepSeekLlmApiExtensionRegistry from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import * as PluginInventory from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  try {
    await context?.fiber.dispose()
  } finally {
    context = undefined
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

it.each([true, false])('reports an unversioned package by name alongside a versioned sibling (private=%s)', async (isPrivate) => {
  root = await mkdtemp(join(tmpdir(), 'dsh-private-package-composition-'))
  const parent = join(root, 'inspector')
  const privateDir = join(parent, 'skill')
  const siblingDir = join(parent, 'sibling')
  await mkdir(privateDir, { recursive: true })
  await mkdir(siblingDir)
  await writeFile(join(parent, 'package.json'), JSON.stringify({ name: 'inspector', version: '1.0.0', type: 'module' }))
  await writeFile(join(privateDir, 'package.json'), JSON.stringify({ name: 'inspector-skill', private: isPrivate, type: 'module' }))
  await writeFile(join(siblingDir, 'package.json'), JSON.stringify({ name: 'inspector-sibling', version: '2.0.0', type: 'module' }))
  await writeFile(join(privateDir, 'plugin.js'), 'export default () => {}\n')
  await writeFile(join(siblingDir, 'plugin.js'), 'export default () => {}\n')
  const privateUrl = pathToFileURL(join(privateDir, 'plugin.js')).href
  const siblingUrl = pathToFileURL(join(siblingDir, 'plugin.js')).href
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: cordis:agents',
    '- name: cordis:deepseek-extensions',
    '- name: cordis:plugin-inventory',
    `- name: ${JSON.stringify(privateUrl)}`,
    `- name: ${JSON.stringify(siblingUrl)}`,
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(configPath).href
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.builtins.agents = AgentRegistry
  ctx.loader.builtins['deepseek-extensions'] = DeepSeekLlmApiExtensionRegistry
  ctx.loader.builtins['plugin-inventory'] = PluginInventory
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const activeNames = [...ctx.loader.entries()]
    .filter(entry => entry.fiber?.state === FiberState.ACTIVE)
    .map(entry => entry.options.name)
  expect(activeNames).toEqual(expect.arrayContaining(['cordis:plugin-inventory', privateUrl, siblingUrl]))

  const prepared = await ctx.deepseekLlmApiExtensions.prepare({
    body: { messages: [] }, signal: new AbortController().signal,
  })
  expect(prepared.fields).toMatchInlineSnapshot(`
    {
      "dsh_plugin_packages": {
        "packages": [
          {
            "name": "inspector-sibling",
            "version": "2.0.0",
          },
          {
            "name": "inspector-skill",
          },
        ],
        "version": 1,
      },
    }
  `)
})
