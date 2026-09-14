/** Build-owned, same-version PDF.js resources; all binary assets are decoded locally. */
import workerSource from 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

export { workerSource }

/** Resource kinds used by PDF.js 6's BinaryDataFactory requests. */
export type PdfAssetKind = 'cMapUrl' | 'standardFontDataUrl' | 'wasmUrl'

/** Original filenames mapped to base64, in the same PDF.js version as the worker. */
export type PdfAssetMap = Readonly<Record<PdfAssetKind, Readonly<Record<string, string>>>>

declare global {
  /** Inline artifact data supplied by the package-local build configuration. */
  const __DSH_PDFJS_ASSETS__: PdfAssetMap
}

/** Public methods required by PDF.js's BinaryDataFactory option. */
export interface PdfBinaryDataFactory {
  /** @param request - PDF.js resource kind and exact filename. @returns independent transferable resource bytes. */
  fetch(request: { readonly kind: PdfAssetKind; readonly filename: string }): Promise<Uint8Array>
}

/**
 * Capture this build's binary assets without network fallbacks.
 * @param assets - build-inlined base64 resources, read only when a PDF is opened.
 * @returns the constructor passed to PDF.js getDocument.
 */
export function createPdfBinaryDataFactory(assets: PdfAssetMap = __DSH_PDFJS_ASSETS__): new () => PdfBinaryDataFactory {
  return class implements PdfBinaryDataFactory {
    fetch({ kind, filename }: { readonly kind: PdfAssetKind; readonly filename: string }): Promise<Uint8Array> {
      return Promise.resolve().then(() => {
        const files = assets[kind]
        const data = Object.hasOwn(files, filename) ? files[filename] : undefined
        if (data === undefined) throw new Error(`PDF.js asset is not bundled: ${kind}/${filename}`)
        return Uint8Array.from(atob(data), character => character.charCodeAt(0))
      })
    }
  }
}
