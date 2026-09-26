/**
 * DeepSeek vision-token accounting: the provider's published image-token
 * calculator (api-docs.deepseek.com, Token & Token Usage) ported verbatim in
 * its current `v41` configuration. The provider scales an image below
 * 544×544 total pixels up, aligns it to a 14px-patch grid, downsamples 3:1
 * per axis into token cells, and caps one image at 1024 tokens by solving the
 * largest aspect-preserving grid inside that budget. The count is exact: this
 * configuration has no alignment pad and no aspect-ratio clamp. Actual usage
 * remains authoritative.
 *
 * @module dsh-llm-deepseek/image-tokens
 */

import { longEdgeDimensions } from '@deepseek-ai/dsh-attachment'
import type { ProjectedDimensions } from '@deepseek-ai/dsh-attachment'
/** Vision patch edge in pixels. */
const PATCH_SIZE = 14
/** Per-axis patch-to-token downsampling ratio. */
const DOWNSAMPLE_RATIO = 3
/** Provider cap on tokens for one request image. */
const MAX_IMAGE_TOKENS = 1024
/** Total-pixel floor; smaller images are scaled up before grid projection. */
const MIN_PIXELS = 544 * 544
/** Pixels covered by one token cell along either axis. */
const CELL_SIZE = PATCH_SIZE * DOWNSAMPLE_RATIO

const intDiv = (value: number, divisor: number): number => Math.floor(value / divisor)
const ceilDiv = (value: number, divisor: number): number => Math.floor((value + divisor - 1) / divisor)

interface GridResize {
  readonly gridHeight: number
  readonly gridWidth: number
  readonly bestHeight: number
  readonly bestWidth: number
  readonly numTokens: number
}

/** Token count of one grid: every row carries a separator, plus two framing tokens. */
function gridTokens(gridHeight: number, gridWidth: number): number {
  return gridHeight * (gridWidth + 1) + 2
}

/** Token-cell count along one padded pixel axis. */
function gridCells(paddedLength: number): number {
  return ceilDiv(intDiv(paddedLength, PATCH_SIZE), DOWNSAMPLE_RATIO)
}

/** Solve the largest grid within `budget` tokens preserving the aspect ratio. */
function solveResizeRatio(height: number, width: number, budget: number): GridResize {
  const aspect = height / width
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5
  const idealGridHeight = idealGridWidth * aspect
  let bestHeight: number
  let bestWidth: number
  if (idealGridWidth < 1) {
    const solvedGridWidth = 1
    const solvedGridHeight = intDiv(budget - 2, solvedGridWidth + 1)
    bestWidth = solvedGridWidth * CELL_SIZE
    bestHeight = solvedGridHeight * CELL_SIZE
  } else if (idealGridHeight < 1) {
    const solvedGridHeight = 1
    const solvedGridWidth = intDiv(budget - 2, solvedGridHeight) - 1
    bestWidth = solvedGridWidth * CELL_SIZE
    bestHeight = solvedGridHeight * CELL_SIZE
  } else {
    const solvedGridWidth = Math.trunc(idealGridWidth)
    const solvedGridHeight = Math.trunc(idealGridHeight)
    const scale = Math.min(solvedGridWidth * CELL_SIZE / width, solvedGridHeight * CELL_SIZE / height)
    bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE
    bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE
  }
  const gridHeight = gridCells(bestHeight)
  const gridWidth = gridCells(bestWidth)
  return { gridHeight, gridWidth, bestHeight, bestWidth, numTokens: gridTokens(gridHeight, gridWidth) }
}

/** Project padded pixel dimensions onto the largest in-budget token grid. */
function safeResize(height: number, width: number, paddedHeight: number, paddedWidth: number): GridResize {
  const gridHeight = gridCells(paddedHeight)
  const gridWidth = gridCells(paddedWidth)
  const direct: GridResize = {
    gridHeight,
    gridWidth,
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(gridHeight, gridWidth),
  }
  if (direct.numTokens <= MAX_IMAGE_TOKENS) return direct
  const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS)
  /* v8 ignore next 3 -- the published solver's assertion; the closed-form
     solve stays within the budget for every positive geometry. */
  if (solved.numTokens > MAX_IMAGE_TOKENS) {
    throw new Error(`deepseek image tokens: no grid fits the token budget for ${width}x${height}`)
  }
  return solved
}

/** One scale-pad-project pass; the caller iterates it to a fixpoint. */
function resizeOnce(width: number, height: number): GridResize {
  let scaledWidth = width
  let scaledHeight = height
  const pixels = scaledWidth * scaledHeight
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    scaledWidth = Math.trunc(scaledWidth * scale)
    scaledHeight = Math.trunc(scaledHeight * scale)
  }
  const paddedWidth = ceilDiv(scaledWidth, PATCH_SIZE) * PATCH_SIZE
  const paddedHeight = ceilDiv(scaledHeight, PATCH_SIZE) * PATCH_SIZE
  return safeResize(scaledHeight, scaledWidth, paddedHeight, paddedWidth)
}

function sameResize(a: GridResize, b: GridResize): boolean {
  return a.gridHeight === b.gridHeight
    && a.gridWidth === b.gridWidth
    && a.bestHeight === b.bestHeight
    && a.bestWidth === b.bestWidth
    && a.numTokens === b.numTokens
}

/**
 * Dimensions the harness sends so the provider keeps the whole image: the
 * source itself when its patch-padded grid fits the token cap, otherwise the
 * source aspect ratio at the solved grid's long edge. The provider pads the
 * short edge to whole patches on its side. Rounding the aspect-preserving
 * short edge can change the token count from the source's solved grid;
 * request pricing uses the sent dimensions. Small images are never enlarged.
 * @param width - positive integer source width in pixels.
 * @param height - positive integer source height in pixels.
 * @returns the request dimensions to encode.
 */
export function deepSeekRequestImageDimensions(width: number, height: number): ProjectedDimensions {
  const paddedWidth = ceilDiv(width, PATCH_SIZE) * PATCH_SIZE
  const paddedHeight = ceilDiv(height, PATCH_SIZE) * PATCH_SIZE
  if (gridTokens(gridCells(paddedHeight), gridCells(paddedWidth)) <= MAX_IMAGE_TOKENS) return { width, height }
  const solved = solveResizeRatio(height, width, MAX_IMAGE_TOKENS)
  return longEdgeDimensions(width, height, width >= height ? solved.bestWidth : solved.bestHeight)
}

/**
 * Vision tokens DeepSeek charges for one request image of the given
 * dimensions.
 * @param width - positive integer request-image width in pixels.
 * @param height - positive integer request-image height in pixels.
 * @returns the provider vision-token price, at most 1024.
 */
export function deepSeekImageTokens(width: number, height: number): number {
  let result = resizeOnce(width, height)
  for (let iteration = 1; iteration < 10; iteration += 1) {
    const next = resizeOnce(result.bestWidth, result.bestHeight)
    if (sameResize(next, result)) return result.numTokens
    result = next
  }
  /* v8 ignore next 2 -- the published solver's non-convergence guard; every
     pass is a projection, so a second identical pass is a fixpoint. */
  throw new Error(`deepseek image tokens: resize did not converge for ${width}x${height}`)
}
