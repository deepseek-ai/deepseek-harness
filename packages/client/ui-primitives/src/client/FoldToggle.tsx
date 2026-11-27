interface FoldToggleProps {
  className: string | undefined
  expanded: boolean
  hidden: number
  labels: {
    collapseAria: string
    expandAria: (hidden: number) => string
    collapse: string
    expand: (hidden: number) => string
  }
  onToggle: () => void
}

/**
 * Render the shared head-tail fold control with caller-owned localized copy.
 * @param props - Fold state, localized labels, and toggle callback.
 * @returns The accessible expand or collapse button.
 */
export function FoldToggle({
  className, expanded, hidden, labels, onToggle,
}: FoldToggleProps) {
  return (
    <button
      type="button"
      className={className}
      aria-expanded={expanded}
      aria-label={expanded ? labels.collapseAria : labels.expandAria(hidden)}
      onClick={onToggle}
    >
      {expanded ? labels.collapse : labels.expand(hidden)}
    </button>
  )
}
