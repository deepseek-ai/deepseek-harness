/** PNG header inspection without a native image decoder. */
const PNG_IHDR = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82])

/**
 * Read the dimensions of a PNG with its mandatory first IHDR chunk.
 * @param png - encoded image bytes.
 * @returns width and height in pixels.
 * @throws when the PNG signature or IHDR chunk is missing.
 */
export function pngSize(png: Buffer): readonly [number, number] {
  if (png.length < 33 || !png.subarray(0, PNG_IHDR.length).equals(PNG_IHDR)) throw new Error('Expected a PNG IHDR chunk')
  return [png.readUInt32BE(16), png.readUInt32BE(20)]
}
