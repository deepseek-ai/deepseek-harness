/** Deterministic two-page PDF with colored rectangles, selectable text, and an explicit xref table. */

/**
 * @param userUnit - Page-coordinate unit size as a multiple of 1/72 inch.
 * @param rotation - Clockwise page rotation in degrees.
 * @returns complete PDF bytes; no clocks, external fonts, images, or network references.
 */
export function pdfFixture(userUnit = 1, rotation = 0): Uint8Array {
  const streams = ['0.9 0.1 0.1 rg 10 10 100 80 re f', '0.1 0.1 0.9 rg 10 10 100 80 re f']
    .map(stream => `${stream}\nBT /F1 8 Tf 0 0 0 rg 10 92 Td (Selectable PDF text) Tj ET`)
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    `<< /Type /Page /Parent 2 0 R /UserUnit ${userUnit} /Rotate ${rotation} /MediaBox [0 0 120 100] /Resources << /Font << /F1 7 0 R >> >> /Contents 4 0 R >>`,
    `<< /Length ${streams[0]!.length} >>\nstream\n${streams[0]}\nendstream`,
    `<< /Type /Page /Parent 2 0 R /UserUnit ${userUnit} /Rotate ${rotation} /MediaBox [0 0 120 100] /Resources << /Font << /F1 7 0 R >> >> /Contents 6 0 R >>`,
    `<< /Length ${streams[1]!.length} >>\nstream\n${streams[1]}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  return pdfObjects(objects)
}

/** @returns a journal-like page with table cells, spaced text fragments, and blank regions for drag selection. */
export function selectionPdfFixture(): Uint8Array {
  const lines: Array<[number, number, string]> = [
    [40, 460, 'JOURNAL'], [40, 415, 'TODAY'],
    [40, 385, '*'], [40, 355, '*'], [40, 325, '*'],
    [40, 275, 'THREE TASKS'], [50, 245, 'NUMBER'], [180, 245, 'PRIORITY'], [310, 245, 'DONE'],
    [50, 215, '1'], [180, 215, 'HIGH / MEDIUM / LOW'], [310, 215, '[ ]'],
    [50, 185, '2'], [180, 185, 'HIGH / MEDIUM / LOW'], [310, 185, '[ ]'],
    [50, 155, '3'], [180, 155, 'HIGH / MEDIUM / LOW'], [310, 155, '[ ]'],
    [40, 105, 'REFLECTION'], [40, 65, '*'], [40, 35, 'AFTER TABLE'],
  ]
  const stream = lines.map(([x, y, value]) => `BT /F1 10 Tf ${x} ${y} Td (${value}) Tj ET`).join('\n')
  return pdfObjects([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 500] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ])
}

function pdfObjects(objects: readonly string[]): Uint8Array {
  let text = '%PDF-1.7\n'
  const offsets = [0]
  objects.forEach((object, index) => {
    offsets.push(text.length)
    text += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = text.length
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets.slice(1)) text += `${String(offset).padStart(10, '0')} 00000 n \n`
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(text)
}
