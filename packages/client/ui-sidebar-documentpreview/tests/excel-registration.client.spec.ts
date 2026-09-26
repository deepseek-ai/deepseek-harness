/** Excel registration remains independent of the Office conversion service. */
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { binaryDocumentPath, DocumentPreviewRegistry } from '../src/client/document/registry.ts'
import { Config } from '../src/config.ts'
import { apply } from '../src/client/excel/index.ts'
import { LazyExcelBody } from '../src/client/excel/LazyExcelBody.tsx'
import { en, zh } from '../src/client/excel/locales.ts'

it('registers complete binary reads and removes the slot and locale on disposal', async () => {
  const ctx = new Context()
  const registry = new DocumentPreviewRegistry()
  const removeLocale = vi.fn()
  const removeBody = vi.fn()
  const registerLocale = vi.fn(() => removeLocale)
  const register = vi.fn((_options: unknown, _component: unknown) => removeBody)
  ctx.provide('documentPreviews', registry)
  ctx.provide('locale', { register: registerLocale, bind: () => makeTranslate(en) } as never)
  ctx.provide('slots', { inject: (_name: string, callback: () => () => void) => callback(), register } as never)
  const limits = Config({}).excel
  const fiber = ctx.plugin({ apply: (scope) => { apply(scope, limits) } })
  try {
    await fiber.await()
    for (const path of ['budget.XLSX', 'legacy.xls', 'table.CSV', 'table.tsv']) {
      const candidate = registry.candidates(path)[0]!
      expect(candidate).toMatchObject({ loading: 'bytes-complete', wrap: false, binaryExtensions: ['xlsx', 'xls'] })
      expect(candidate.title()).toBe('Spreadsheet')
      expect(binaryDocumentPath(registry.getSnapshot(), path)).toBe(/\.(xlsx|xls)$/iu.test(path))
    }
    expect(registerLocale).toHaveBeenCalledWith('sidebarExcel', { zh, en })
    expect(register).toHaveBeenCalledOnce()
    expect(register.mock.calls[0]![1]).toBe(LazyExcelBody)
    const options = register.mock.calls[0]![0] as { inject: () => unknown }
    expect(options).toMatchObject({ locale: 'sidebarExcel' })
    expect(options.inject).toBeTypeOf('function')
    expect(options.inject()).toEqual({ limits })
  } finally { await fiber.dispose() }
  expect(registry.getSnapshot()).toEqual([])
  expect(removeLocale).toHaveBeenCalledOnce()
  expect(removeBody).toHaveBeenCalledOnce()
})
