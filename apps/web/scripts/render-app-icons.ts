/**
 * Render the install icons of the Web application from the official
 * application tile.
 *
 * This script rasterizes the official application tile
 * (`apps/desktop/resources/icon.svg`) into the committed PNGs under `public/`.
 * The bare favicon has no background, and its edge-to-edge fins can be cropped
 * by a launcher mask. The tile's drop shadow belongs to a desktop window, so
 * every install variant crops it. The generic 192px and 512px icons have
 * transparent rounded corners matching the macOS tile. Safari prefers the
 * linked Apple touch icon, which stays square for system masking. The maskable
 * variant scales the whale inside the platform's safe zone while retaining
 * the tile's own gradient to the edges, so no platform mask meets a seam.
 *
 * The committed PNGs are the output; rerun
 * `pnpm --filter @deepseek-ai/dsh-web-frontend run render:app-icons` after the
 * tile artwork changes.
 * @module render-app-icons
 */

import { readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertNever } from '@deepseek-ai/dsh-util-values'

/** Vector source owned by the desktop application; 1104 units square with the tile inset. */
export const TILE_SOURCE = fileURLToPath(new URL('../../desktop/resources/icon.svg', import.meta.url))

/** Directory the generated PNGs are committed to. */
export const ICON_OUTPUT_DIRECTORY = fileURLToPath(new URL('../public/', import.meta.url))

/** Tile edge in source units; every render density is expressed against it. */
const TILE_EDGE = 1024

/** Corner radius in source units, matching `apps/desktop/resources/icon-macos.svg`. */
const TILE_CORNER_RADIUS = 230

/** Tile inset in the source canvas: the drop shadow occupies the surrounding band. */
const TILE_INSET = { x: 40, y: 32 } as const

/** Tile centre in source units, the fixed point of the maskable scale. */
const TILE_CENTER = { x: TILE_INSET.x + TILE_EDGE / 2, y: TILE_INSET.y + TILE_EDGE / 2 } as const

/** Density at which the source's own 1:1 scale renders. */
const SOURCE_DENSITY = 72

/** Samples per output pixel along each axis before reduction. */
const RENDER_SCALE = 4

/**
 * Fraction of a maskable icon the artwork keeps: the platform may crop the
 * border outside it. The tile's own ink reaches 0.461 of its edge from the
 * centre, so 0.868 is the largest scale a circular mask still shows whole;
 * `pwa-manifest.e2e.ts` checks the committed artwork against that circle.
 */
export const MASKABLE_ARTWORK_SCALE = 0.82

/** Radius a platform mask is guaranteed to show, as a fraction of the icon edge. */
export const MASKABLE_SAFE_RADIUS_RATIO = 0.4

/** Root element of the source document, rewritten to crop the canvas to the tile. */
const SOURCE_ROOT = /^<svg[^>]*>/u

/** Source definitions element, including attributes preserved during clip insertion. */
const SOURCE_DEFINITIONS = /<defs(?:\s[^>]*)?>/u

/** The tile group's drop shadow; stripped because a launcher icon has no window around it. */
const TILE_SHADOW_GROUP = '<g filter="url(#filter0_d_1637_371)">'

/** The whale group inside the tile; the only element a maskable icon scales. */
const TILE_ARTWORK_GROUP = '<g filter="url(#filter1_ddi_1637_371)">'

/** One committed install icon: the manifest or link member it serves and its edge in pixels. */
export interface AppIconVariant {
  /** File name inside `public/`. */
  readonly file: string
  /** Square edge in pixels. */
  readonly size: number
  /** Target rendering; `tile` is an opaque square for system masking. */
  readonly kind: 'rounded' | 'tile' | 'maskable'
}

/**
 * Install icons the Web application ships. Chrome requires the 192px and 512px
 * raster pair to offer installation. Platforms that apply their own masks
 * receive a separate opaque maskable icon; Safari prefers the linked Apple touch icon.
 */
export const APP_ICON_VARIANTS: readonly AppIconVariant[] = [
  { file: 'icon-192.png', size: 192, kind: 'rounded' },
  { file: 'icon-512.png', size: 512, kind: 'rounded' },
  { file: 'icon-maskable-512.png', size: 512, kind: 'maskable' },
  { file: 'apple-touch-icon.png', size: 180, kind: 'tile' },
]

/** The cropped 1:1 root every variant shares, at the tile's own square extent. */
function croppedRoot(): string {
  return `<svg width="${String(TILE_EDGE)}" height="${String(TILE_EDGE)}"`
    + ` viewBox="${String(TILE_INSET.x)} ${String(TILE_INSET.y)} ${String(TILE_EDGE)} ${String(TILE_EDGE)}"`
    + ' fill="none" xmlns="http://www.w3.org/2000/svg">'
}

/** A scale about the tile centre, so a masked crop stays symmetric. */
function aboutCenter(scale: number): string {
  return `translate(${String(TILE_CENTER.x)} ${String(TILE_CENTER.y)}) scale(${String(scale)})`
    + ` translate(${String(-TILE_CENTER.x)} ${String(-TILE_CENTER.y)})`
}

/** Replace the source root so the icon canvas is exactly the tile. */
function reparent(source: string, tileGroup = '<g>'): string {
  const trimmed = source.trim()
  const root = SOURCE_ROOT.exec(trimmed)
  if (root === null) throw new Error('app icons: the tile source has no root element')
  if (!trimmed.includes(TILE_SHADOW_GROUP)) throw new Error('app icons: the tile source has no shadowed tile group')
  if (!trimmed.includes(TILE_ARTWORK_GROUP)) throw new Error('app icons: the tile source has no artwork group')
  if (!SOURCE_DEFINITIONS.test(trimmed)) throw new Error('app icons: the tile source has no definitions element')
  return `${croppedRoot()}${trimmed.slice(root[0].length).replace(TILE_SHADOW_GROUP, tileGroup)}`
}

/**
 * Rewrite the tile source so the icon canvas is exactly the tile.
 * @param source - complete `icon.svg` document.
 * @returns an SVG document whose 1024-unit square is the tile without its shadow.
 */
export function tileDocument(source: string): string {
  return reparent(source)
}

/**
 * Round the generic install tile for launchers that display it without a mask.
 * @param source - complete `icon.svg` document.
 * @returns an SVG document with transparent rounded corners and unscaled artwork.
 */
export function roundedDocument(source: string): string {
  return reparent(source, '<g clip-path="url(#install-tile-clip)">')
    .replace(SOURCE_DEFINITIONS, '$&<clipPath id="install-tile-clip"><rect'
      + ` x="${String(TILE_INSET.x)}" y="${String(TILE_INSET.y)}"`
      + ` width="${String(TILE_EDGE)}" height="${String(TILE_EDGE)}"`
      + ` rx="${String(TILE_CORNER_RADIUS)}"/></clipPath>`)
}

/**
 * Rewrite the tile source into a maskable icon. The tile keeps its own gradient
 * and extent, so the icon's border is the real tile rather than an extension;
 * only the whale scales into the safe zone a platform mask may crop.
 * @param source - complete `icon.svg` document.
 * @returns an SVG document whose artwork survives a circular mask whole.
 */
export function maskableDocument(source: string): string {
  const relocated = reparent(source)
  return relocated.replace(
    TILE_ARTWORK_GROUP,
    `${TILE_ARTWORK_GROUP.slice(0, -1)} transform="${aboutCenter(MASKABLE_ARTWORK_SCALE)}">`,
  )
}

/**
 * Rasterize one rewritten document at a square edge.
 * @param document - output of {@link tileDocument}, {@link roundedDocument} or {@link maskableDocument}.
 * @param size - square edge in pixels.
 * @returns the PNG bytes.
 */
async function renderPng(document: string, size: number): Promise<Buffer> {
  const { default: sharp } = await import('sharp')
  const renderSize = Math.max(TILE_EDGE, size * RENDER_SCALE)
  // A separate raster preserves the source's filters at full resolution and
  // prevents SVG resize optimizations from bypassing the downsampling step.
  const raster = await sharp(Buffer.from(document), { density: SOURCE_DENSITY * renderSize / TILE_EDGE })
    .png()
    .toBuffer()
  return sharp(raster)
    .resize(size, size, { kernel: 'lanczos3' })
    .png()
    .toBuffer()
}

function documentForVariant(source: string, kind: AppIconVariant['kind']): string {
  switch (kind) {
    case 'rounded': return roundedDocument(source)
    case 'tile': return tileDocument(source)
    case 'maskable': return maskableDocument(source)
    default: return assertNever(kind)
  }
}

/**
 * Render every install icon from the tile source.
 * @param source - complete `icon.svg` document.
 * @returns one PNG per {@link APP_ICON_VARIANTS} entry, in declaration order.
 */
export async function renderAppIcons(source: string): Promise<readonly { variant: AppIconVariant; png: Buffer }[]> {
  return Promise.all(APP_ICON_VARIANTS.map(async variant => ({
    variant,
    png: await renderPng(
      documentForVariant(source, variant.kind),
      variant.size,
    ),
  })))
}

async function main(): Promise<void> {
  const icons = await renderAppIcons(await readFile(TILE_SOURCE, 'utf8'))
  await Promise.all(icons.map(async ({ variant, png }) => {
    await writeFile(resolve(ICON_OUTPUT_DIRECTORY, variant.file), png)
  }))
  console.info(`app icons: wrote ${icons.map(icon => icon.variant.file).join(', ')} to ${ICON_OUTPUT_DIRECTORY}`)
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
