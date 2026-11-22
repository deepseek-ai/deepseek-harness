/** Shipped SDK recommendation discovery, training opt-out and the caller's final text. */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockLlmServer } from '@deepseek-ai/dsh-llm-mock-server'
import { DeepSeekHarness } from '@deepseek-ai/dsh-sdk-client'
import type {} from '@deepseek-ai/dsh-tool-skill'
import { expect, it, onTestFinished } from 'vitest'
import { profileEnvironment } from './fixtures/profile-environment.ts'

const card = '```action-card\n{"action":"create_personalized_page","title":"Notes","brief":"Collect notes","details":{"slot":"page"}}\n```'

it.each([true, false])('returns card text with recommendation skills enabled=%s', async (enabled) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-sdk-recommendations-'))
  onTestFinished(() => rm(root, { recursive: true, force: true }))
  const server = await startMockLlmServer({
    sequence: ['tool_call_success', 'success'], toolName: 'skill',
    toolArguments: JSON.stringify({ name: 'personalized-pages' }), successText: card,
  })
  onTestFinished(() => server.close())
  const patches: string[] = []
  if (!enabled) {
    const patch = join(root, 'training.yml')
    await writeFile(patch, '- id: action-cards\n  config:\n    enabled: false\n')
    patches.push(patch)
  }
  await using harness = new DeepSeekHarness({
    dshBin: fileURLToPath(new URL('../../../lib/bin.js', import.meta.url)),
    cwd: root, processCwd: root, dshHome: join(root, 'home'), patches,
    env: profileEnvironment(root, server.baseURL), initializeTimeoutMs: 30_000,
  })
  const run = await harness.run('I would like a notes page in this app.')
  const names = run.events.flatMap(event => event.type === 'user/message' && event.data.source.kind === 'skill-catalog'
    ? event.data.source.entries.map(entry => entry.name) : [])
  expect(names).toContain('office')
  for (const name of ['official-plugins', 'personalized-pages']) expect(names.includes(name)).toBe(enabled)
  const result = run.events.flatMap(event => event.type === 'tool/result' ? event.data.message.content : [])
    .flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
  expect(result).toContain(enabled ? '<skill_content name="personalized-pages">' : 'skill "personalized-pages" is unknown or no longer available')
  expect(run.finalResponse).toBe(card)
})
