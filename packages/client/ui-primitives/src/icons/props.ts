/** Shared props for every product icon component. */
export interface IconProps {
  /** Square edge in px; defaults to the glyph's own drawn size. */
  size?: number | undefined
  /** Extra class for layout placement; color rides currentColor.
   * (`| undefined` for exactOptionalPropertyTypes: callers forward their own optional prop.) */
  className?: string | undefined
}
