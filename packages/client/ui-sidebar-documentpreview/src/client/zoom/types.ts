/** Automatic fit or an explicit actual-size scale selected by the reader. */
export type ZoomPreference =
  | { readonly kind: 'fit-width' }
  | { readonly kind: 'fixed'; readonly scale: number }

/** Default preference for a newly opened zoomable preview. */
export const FIT_WIDTH: ZoomPreference = { kind: 'fit-width' }

/** Minimum scale retained by a fixed zoom preference. */
export const MIN_FIXED_ZOOM = 0.25

/** Maximum scale retained by a fixed zoom preference. */
export const MAX_FIXED_ZOOM = 4

/** Scale interval used by the incremental controls. */
export const ZOOM_STEP = 0.25

/** Fixed scale choices shown in the zoom menu. */
export const ZOOM_OPTIONS = [0.25, 0.5, 1, 1.5, 2] as const

/** Localized copy consumed by the framework-free zoom controls. */
export interface ZoomLabels {
  readonly controls: string
  readonly menu: string
  readonly out: string
  readonly into: string
  readonly fitWidth: string
  readonly value: (percent: number) => string
}
