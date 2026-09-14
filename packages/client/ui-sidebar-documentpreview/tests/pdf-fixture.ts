/** Deterministic two-page PDF with red and blue vector rectangles and an explicit xref table. */

/** @returns complete PDF bytes; no clocks, external fonts, images, or network references. */
export function pdfFixture(): Uint8Array {
  const streams = ['0.9 0.1 0.1 rg 10 10 100 80 re f', '0.1 0.1 0.9 rg 10 10 100 80 re f']
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 100] /Resources << >> /Contents 4 0 R >>',
    `<< /Length ${streams[0]!.length} >>\nstream\n${streams[0]}\nendstream`,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 100] /Resources << >> /Contents 6 0 R >>',
    `<< /Length ${streams[1]!.length} >>\nstream\n${streams[1]}\nendstream`,
  ]
  let text = '%PDF-1.4\n'
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
