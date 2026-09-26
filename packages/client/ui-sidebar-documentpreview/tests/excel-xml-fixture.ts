/** Equivalent XML encodings and package layouts produced with XlsxWriter. */
import { readFile } from 'node:fs/promises'

/** Baseline and equivalent workbooks covering XML text and relocated core parts. */
export const excelXmlCases = ['rich', 'utf16-sheet', 'utf16-metadata', 'workbook-path', 'styles-path', 'strings-path', 'cdata', 'parts-path'] as const

/**
 * Read committed independent-writer bytes for parser and browser tests.
 * @param name - Retained fixture name.
 * @returns Complete XLSX bytes owned by the caller.
 */
export async function excelXmlFixture(name: typeof excelXmlCases[number]): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await readFile(new URL(`./fixtures/excel-xml/${name}.xlsx`, import.meta.url)))
}
