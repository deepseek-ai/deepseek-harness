/** Shared props for every product icon component. */
export interface IconProps {
  /** Rendered height in CSS px; stroked geometry retains its Regular or Medium width. */
  size?: number | undefined
  /** Extra class for layout placement; color rides currentColor.
   * (`| undefined` for exactOptionalPropertyTypes: callers forward their own optional prop.) */
  className?: string | undefined
}
