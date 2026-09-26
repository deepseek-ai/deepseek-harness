/** Binary BIFF fixture with saved formulas, dates, merges, and hidden worksheets. */
import { utils, write, type CellObject, type WorkBook } from 'xlsx'

/**
 * Build a legacy workbook for parser and browser scenarios.
 * @param date1904 - Whether date serials use the 1904 epoch.
 * @returns A workbook accepted by the BIFF writer.
 */
export function legacyWorkbook(date1904 = false): WorkBook {
  const workbook = utils.book_new()
  const sheet = utils.aoa_to_sheet([
    ['旧版预算', null, null], ['项目', '金额', '比例'], ['研发', 1234.5, 0.25],
    ['公式结果', 3, null], ['日期', date1904 ? 43890 : 45352, true],
  ])
  const amount = sheet['B3'] as CellObject | undefined
  const ratio = sheet['C3'] as CellObject | undefined
  const date = sheet['B5'] as CellObject | undefined
  if (amount === undefined || ratio === undefined || date === undefined) throw new Error('legacy fixture cells are missing')
  amount.z = '#,##0.00'
  ratio.z = '0.0%'
  date.z = 'yyyy-mm-dd'
  // MS-XLS CellParsedFormula: seven token bytes encode the expression 1+2.
  sheet['B4'] = { t: 'n', v: 3, bf: [7, 0, 0x1e, 1, 0, 0x1e, 2, 0, 0x03] } as CellObject & { bf: number[] }
  sheet['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }]
  sheet['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 12, hidden: true }]
  sheet['!rows'] = [{ hpt: 30 }, {}, {}, {}, { hidden: true }]
  utils.book_append_sheet(workbook, sheet, '预算')
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([['Second sheet']]), '明细')
  utils.book_append_sheet(workbook, utils.aoa_to_sheet([['Hidden']]), '隐藏')
  workbook.Workbook = { WBProps: { date1904 }, Sheets: [{ Hidden: 0, name: '预算' }, { Hidden: 0, name: '明细' }, { Hidden: 1, name: '隐藏' }] }
  return workbook
}

/**
 * Serialize the legacy workbook to a real XLS container.
 * @param workbook - Fixture workbook, optionally modified by the scenario.
 * @returns Complete BIFF8 compound-file bytes.
 */
export function xlsFixture(workbook = legacyWorkbook()): Uint8Array<ArrayBuffer> {
  return new Uint8Array(write(workbook, { type: 'array', bookType: 'biff8' }) as ArrayBuffer)
}
