/** Speech preferences persisted through the profile's Loader and Settings services. */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { boot, initProfile, readProfilePatches, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import ConfigEditor from '@deepseek-ai/dsh-config-editor'
import Settings from '@deepseek-ai/dsh-settings'
import SpeechToText from '../src/index.ts'
import type { SpeechProviderId } from '../src/types.ts'

it('saves language and provider preferences without remounting and restores them at restart', async () => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-speech-configuration-')))
  let ctx: Awaited<ReturnType<typeof boot>> | undefined
  try {
    const dir = join(home, 'profiles', 'test')
    initProfile(dir, ['test-bundle'])
    const bundle = join(dir, 'node_modules', 'test-bundle')
    mkdirSync(bundle, { recursive: true })
    writeFileSync(join(home, 'package.json'), '{"name":"test-installation"}\n')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'test-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }))
    writeFileSync(join(bundle, 'cordis.patch.yml'), readFileSync(new URL('./fixtures/selection.patch.yml', import.meta.url)))
    writeFileSync(join(dir, 'cordis.yml'), '[]\n')
    const profile: ProfileContext = {
      name: 'test', startedBundles: ['test-bundle'], dir, patchPath: join(dir, 'cordis.patch.yml'),
      installAnchor: join(home, 'package.json'), cwd: home, home, overlays: [], telemetryDisabledEnv: undefined,
    }
    const start = () => boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (root) => {
      root.provide('profileContext', profile)
      Object.assign(root.loader.builtins, { editor: ConfigEditor, settings: Settings, speech: SpeechToText })
    })
    ctx = await start()
    const speech = ctx.get('speechToText')!
    const languages = ['auto', 'zh', 'en', 'yue', 'ja', 'ko']
    for (const id of ['sensevoice-local', 'another-provider']) speech.register({
      info: { id: id as SpeechProviderId, name: id, location: 'host-local', languages },
      transcribe: async () => { throw new Error('Changing preferences must not transcribe audio') },
    })
    const entry = ctx.configEditor.entries().find(row => row.options.id === 'speech-to-text')!
    expect(entry.id).toBe('include:speech-to-text')
    const fiber = entry.fiber
    for (const language of [...languages, 'zh']) {
      await speech.configure({ language })
      expect(speech.snapshot().selection).toEqual({ providerId: 'sensevoice-local', language })
    }
    await speech.configure({ providerId: 'another-provider' as SpeechProviderId })
    expect(speech.snapshot().selection).toEqual({ providerId: 'another-provider', language: 'zh' })
    expect(entry.fiber === fiber).toBe(true)
    const saved = readFileSync(profile.patchPath, 'utf8')
    expect(saved).toContain('id: speech-to-text')
    expect(saved).toContain('defaultProvider: another-provider')
    expect(saved).toContain('language: zh')
    await ctx.fiber.dispose()
    ctx = await start()
    expect(ctx.get('speechToText')!.snapshot().selection).toEqual({ providerId: 'another-provider', language: 'zh' })
  } finally {
    try { await ctx?.fiber.dispose() } finally { rmSync(home, { recursive: true, force: true }) }
  }
})
