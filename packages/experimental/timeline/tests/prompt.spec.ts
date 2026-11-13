import { describe, expect, it } from 'vitest'
import { ZodError } from 'zod'
import { parseSummary } from '../src/prompt.ts'

describe('compact plain-language report output', () => {
  const response = (progress: string[]) => JSON.stringify({ progress, uncertainties: [], userActions: [] })
  it('accepts short English and Chinese output and preserves empty optional groups', () => {
    expect(
      parseSummary(
        response([
          'Opening another plan now keeps the selected task.',
          'Next, check that older plans still open.',
        ]),
        'en',
      ).progress,
    ).toHaveLength(2)
    expect(
      parseSummary(response(['切换计划后，所选任务仍会保留。', '下一步检查旧计划能否正常打开。']), 'zh-CN')
        .uncertainties,
    ).toEqual([])
  })
  it('rejects long sentences, code and more than four progress entries', () => {
    expect(() => parseSummary(response(['Ready.', 'x'.repeat(321)]), 'en')).toThrow()
    expect(() => parseSummary(response(['Changed `activeTreeId`.']), 'en')).toThrow()
    expect(() => parseSummary(response(['The guide is ready.\nCheck it now.']), 'en')).toThrow()
    expect(() => parseSummary(response(['一'.repeat(161)]), 'zh-CN')).toThrow()
    expect(() => parseSummary(response(['One.', 'Two.', 'Three.', 'Four.', 'Five.']), 'en')).toThrow()
    expect(() => parseSummary(response(['x'.repeat(321)]), 'en')).toThrow()
  })
  it('rejects an oversized malformed report without expanding its repair diagnostics per entry', () => {
    try {
      parseSummary(
        JSON.stringify({ progress: Array(20000).fill(null), uncertainties: [], userActions: [] }),
        'en',
      )
    } catch (error: unknown) {
      if (!(error instanceof ZodError)) throw error
      expect(error.issues.length).toBeLessThanOrEqual(4)
      expect(error.message.length).toBeLessThan(4096)
      return
    }
    throw new Error('An oversized malformed report must fail validation')
  })
  it('keeps bounded useful sentences without a format retry for a small word-count overrun', () => {
    const progress = [
      'The restart check passed.',
      'The saved plan and all its completed tasks were still present when the user opened the same session after a restart.',
    ]
    expect(progress[1]?.split(' ').length).toBeGreaterThan(20)
    expect(parseSummary(response(progress), 'en').progress).toEqual(progress)
    expect(parseSummary(response(['一'.repeat(51)]), 'zh-CN').progress).toHaveLength(1)
    expect(parseSummary(response(['x'.repeat(101)]), 'en').progress).toHaveLength(1)
    expect(parseSummary(response(['The guide is ready. Check it now.']), 'en').progress).toHaveLength(1)
    expect(parseSummary(response(['指南已完成。请查看。']), 'zh-CN').progress).toHaveLength(1)
  })
  it('keeps a short preview and accepts supporting evidence, limits and a decided next step', () => {
    const progress = [
      'The planner keeps saved changes after restart.',
      'A restart check preserved the edited plan and completed work.',
      'Recovery after an interrupted save still needs a check.',
      'Next, test that interruption before the release.',
    ]
    expect(parseSummary(response(progress), 'en').progress).toEqual(progress)
  })
  it('keeps concise output rules in the added languages, including unspaced Japanese sentences', () => {
    for (const [language, text] of [
      ['ja', '別の計画を開いても、選択したタスクが保持されます。'],
      ['es', 'El plan conserva la tarea seleccionada.'],
      ['fr', 'Le plan conserve la tâche sélectionnée.'],
      ['de', 'Der Plan behält die ausgewählte Aufgabe.'],
      ['ru', 'План сохраняет выбранную задачу.'],
      ['pt', 'O plano mantém a tarefa selecionada.'],
    ] as const)
      expect(parseSummary(response([text]), language).progress).toEqual([text])
    expect(() => parseSummary(response(['あ'.repeat(161)]), 'ja')).toThrow()
    expect(parseSummary(response(['完了しました。次を確認します。']), 'ja').progress).toHaveLength(1)
    expect(() =>
      parseSummary(response([Array.from({ length: 41 }, () => 'palavra').join(' ')]), 'pt'),
    ).toThrow()
  })
})
