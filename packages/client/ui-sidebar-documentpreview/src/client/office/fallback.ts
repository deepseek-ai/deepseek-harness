/** Office-owned fallback selection for both content loading and presentation. */

/**
 * Select the existing renderer after native Office preview is unavailable or fails.
 * @param path - Decoded source file path.
 * @returns Workbook bytes for XLSX and XLS; converted PDF for Word and PowerPoint.
 */
export function officeFallback(path: string): 'spreadsheet' | 'pdf' {
  return /\.xlsx?$/i.test(path) ? 'spreadsheet' : 'pdf'
}
