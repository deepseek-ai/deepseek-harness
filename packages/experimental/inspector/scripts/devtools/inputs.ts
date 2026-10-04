/** Immutable npm source discovery and generated frontend build inputs. */
import { readFile, readdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEVTOOLS_NPM_VERSION } from './source.ts'

/**
 * Resolve the installed, exact frontend source version without network access.
 * @returns The immutable npm package directory.
 */
export async function frontendSourceRoot(): Promise<string> {
  const file = fileURLToPath(import.meta.resolve('chrome-devtools-frontend/package.json'))
  const manifest: unknown = JSON.parse(await readFile(file, 'utf8'))
  if (typeof manifest !== 'object' || manifest === null || !('version' in manifest) || manifest.version !== DEVTOOLS_NPM_VERSION) {
    throw new Error(`Expected chrome-devtools-frontend ${DEVTOOLS_NPM_VERSION}`)
  }
  return dirname(file)
}

/**
 * Enumerate icons in the flattened layout used by DevTools.
 * @param frontEnd - Installed frontend source directory.
 * @returns Original paths and destination filenames.
 */
export async function frontendImages(frontEnd: string): Promise<Array<{ source: string; name: string }>> {
  const files: Array<{ source: string; name: string }> = []
  for (const dir of [join(frontEnd, 'Images'), join(frontEnd, 'Images/src')]) {
    for (const file of await readdir(dir, { withFileTypes: true })) {
      if (file.isFile() && /\.(?:svg|png|avif|gif|webp|jpe?g)$/u.test(file.name)) {
        files.push({ source: join(dir, file.name), name: file.name })
      }
    }
  }
  if (new Set(files.map(file => file.name)).size !== files.length) throw new Error('DevTools flattened image filenames collide')
  return files.sort((left, right) => left.name.localeCompare(right.name))
}

/**
 * Generate the stylesheet-backed icon module from the npm package's image files.
 * @param images - Flattened icon filenames.
 * @returns Browser module assigning the upstream image CSS variables.
 */
export function imagesModule(images: readonly { name: string }[]): string {
  return `const sheet = new CSSStyleSheet(); sheet.replaceSync(":root {}");
const style = sheet.cssRules[0].style;
${images.map(({ name }) => `style.setProperty(${JSON.stringify(`--image-file-${name.replace(/\.[^.]+$/u, '')}`)}, 'url("' + new URL(${JSON.stringify(`Images/${name}`)}, document.baseURI).href + '")');`).join('\n')}
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];`
}
