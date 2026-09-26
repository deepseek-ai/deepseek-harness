/** Independent-writer XLSX files shared by parser and shipped-browser regressions. */
import { readFile } from 'node:fs/promises'

/** Five isolated failures and one workbook combining their features. */
export const excelOpcCases = ['comments', 'table', 'prefix', 'part-name', 'relative', 'combined'] as const

/**
 * Read an Openpyxl or XlsxWriter fixture without regenerating it with the parser under test.
 * @param name - Retained fixture name.
 * @returns Complete XLSX bytes owned by the caller.
 */
export async function excelOpcFixture(name: typeof excelOpcCases[number]): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await readFile(new URL(`./fixtures/excel-opc/${name}.xlsx`, import.meta.url)))
}
