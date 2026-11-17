/** Kit entry stand-in whose converter writes a fixed PDF for every conversion. */
import { writeFile } from 'node:fs/promises'

/** The converter members the Office kit calls for a conversion and on disposal. */
interface FakeConverter {
  readonly backend: 'native'
  convert(request: { outputPath: string }): Promise<{ backend: 'native'; missingFonts: string[] }>
  dispose(): Promise<void>
}

/**
 * Create a converter that implements only `convert`.
 * @returns a converter writing `%PDF-` bytes to the requested output path.
 */
export function createConverter(): Promise<FakeConverter> {
  return Promise.resolve({
    backend: 'native',
    async convert({ outputPath }) {
      await writeFile(outputPath, '%PDF-1.7\nconverted\n%%EOF\n')
      return { backend: 'native', missingFonts: [] }
    },
    dispose: () => Promise.resolve(),
  })
}
