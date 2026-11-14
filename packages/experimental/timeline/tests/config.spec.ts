import { describe, expect, it } from 'vitest'
import { Config, liveConfig } from '../src/config.ts'
import { appLanguage, outputLanguages } from '../src/policy.ts'
import * as Timeline from '../src/index.ts'
import { setup } from './fixture.ts'

describe('fixed report limits', () => {
  it('rejects unreachable and equal rounded periods through Loader validation', async () => {
    const validate = Config['~standard'].validate
    for (const cadence of [
      { intervalMs: 86400000, rollupFactors: [10] },
      { intervalMs: 60000, rollupFactors: [1 + Number.EPSILON] },
    ]) {
      expect(await validate(cadence)).toMatchObject({ issues: [{ path: ['rollupFactors'] }] })
    }
    expect(await validate({ intervalMs: 86400000, rollupFactors: [7] })).toHaveProperty('value')
    expect(await validate({ intervalMs: 1 })).toHaveProperty('issues')
  })
  it('falls back to English for an unsupported app locale', () => {
    expect(appLanguage('it-IT')).toBe('en')
  })
  it('reads the live app language and rejects an enabled standalone installation', async () => {
    const f = await setup()
    try {
      await f.plugin.dispose()
      const standalone = { disabled: true, options: { name: 'cordis:@magolor/dsh-timeline' } }
      f.ctx.provide('loader', { entries: () => [
        { disabled: false, options: { name: 'other-plugin' } }, standalone,
      ] } as never)
      let value: unknown
      f.ctx.provide('settings', { describe: () => [{ ns: 'other' }, { ns: 'locale', value }] } as never)
      const integrated = await f.ctx.plugin(Timeline, {})
      for (const invalid of [undefined, null, {}, { preference: 1 }]) {
        value = invalid
        const prompt = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
        expect(prompt.sections.find(section => section.name === 'timeline:planning')?.text).toContain(
          'task-tree content only',
        )
      }
      value = { preference: 'zh-CN' }
      const prompt = await f.ctx.systemPrompt.assemble({ agent: f.agent, scope: f.agent })
      expect(prompt.sections.find(section => section.name === 'timeline:planning')?.text).toContain('简体中文')
      await integrated.dispose()
      standalone.disabled = false
      await expect(f.ctx.plugin(Timeline, {})).rejects.toThrow('Disable the standalone Timeline')
    } finally {
      await f.close()
    }
  })
  it('enables segmented progress by default and accepts it without changing task configuration', () => {
    expect(liveConfig(Config({})).segmentedProgress).toBe(true)
    expect(liveConfig(Config({ segmentedProgress: false })).segmentedProgress).toBe(false)
  })
  it('accepts positive whole reminder counts and defaults to 24 iterations', () => {
    expect(liveConfig(Config({})).reminderIterations).toBe(24)
    for (const reminderIterations of [1, 12, 48, 100, Number.MAX_SAFE_INTEGER])
      expect(liveConfig(Config({ reminderIterations })).reminderIterations).toBe(reminderIterations)
    for (const reminderIterations of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])
      expect(() => Config({ reminderIterations })).toThrow()
  })
  it('defaults Todo off and accepts task, global and per-level prompts through 32,768 characters', () => {
    expect(liveConfig(Config({})).allowTodo).toBe(false)
    const prompt = 'x'.repeat(32768)
    expect(liveConfig(Config({ summaryPrompt: prompt, levelPrompts: [prompt] })).summaryPrompt).toHaveLength(
      32768,
    )
    expect(() => Config({ summaryPrompt: prompt + 'x' })).toThrow()
    expect(() => Config({ levelPrompts: [prompt + 'x'] })).toThrow()
    expect(liveConfig(Config({ taskPrompt: prompt })).taskPrompt).toHaveLength(32768)
    expect(liveConfig(Config({ taskPrompt: '' })).taskPrompt).toBe('')
    expect(() => Config({ taskPrompt: prompt + 'x' })).toThrow()
  })
  it('rejects sub-minute intervals and unsupported output languages', () => {
    expect(liveConfig(Config({}))).toMatchObject({
      intervalMs: 900000,
      rollupFactors: [4, 4],
      language: 'ui',
      progressDecimals: 2,
    })
    expect(() => Config({ intervalMs: 59999 })).toThrow()
    expect(() => Config({ intervalMs: 0 })).toThrow()
    expect(liveConfig(Config({ rollupFactors: [2.5] })).rollupFactors).toEqual([2.5])
    expect(() => Config({ rollupFactors: [1] })).toThrow()
    expect(() => Config({ rollupFactors: [0.5] })).toThrow()
    expect(() => { Reflect.apply(Config, undefined, [{ language: 'xx' }]) }).toThrow()
    for (const language of outputLanguages) {
      expect(liveConfig(Config({ language })).language).toBe(language)
      expect(liveConfig(Config({}), () => language).uiLanguage).toBe(language)
    }
    expect(liveConfig(Config({ language: 'zh-CN' })).language).toBe('zh-CN')
    expect(liveConfig(Config({ language: 'ui' })).language).toBe('ui')
    for (const progressDecimals of [0, 1, 2, 3] as const)
      expect(liveConfig(Config({ progressDecimals })).progressDecimals).toBe(progressDecimals)
    expect(() => { Reflect.apply(Config, undefined, [{ progressDecimals: 4 }]) }).toThrow()
  })
})
