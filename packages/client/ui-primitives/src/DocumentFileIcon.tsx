import { useId } from 'react'

/**
 * Render the DeepSeek Web document glyph used by generic-file cards.
 * @param props - optional CSS class for sizing and placement.
 * @returns a decorative document SVG with an instance-safe gradient id.
 */
export function DocumentFileIcon({ className }: { readonly className?: string | undefined }) {
  const gradientId = useId()
  return (
    <svg
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      width="24"
      height="28"
      viewBox="0 0 24 28"
      fill="none"
      aria-hidden
    >
      <path
        d="M16.5 0l7 7v15.6c0 2.25 0 3.375-.573 4.164a3 3 0 0 1-.663.663C21.475 28 20.349 28 18.1 28H5.9c-2.25 0-3.375 0-4.164-.573a3 3 0 0 1-.663-.663C.5 25.975.5 24.849.5 22.6V5.4c0-2.25 0-3.375.573-4.164a3 3 0 0 1 .663-.663C2.525 0 3.651 0 5.9 0h10.6z"
        fill={`url(#${gradientId})`}
      />
      <path
        d="M16.5 0l7 7h-3.8c-1.12 0-1.68 0-2.108-.218a2 2 0 0 1-.874-.874C16.5 5.48 16.5 4.92 16.5 3.8V0z"
        fill="#fff"
        fillOpacity=".55"
      />
      <path
        d="M6 11.784c0-.433.351-.784.784-.784h10.432a.784.784 0 1 1 0 1.568H6.784A.784.784 0 0 1 6 11.784zM6 15.784c0-.433.351-.784.784-.784h10.432a.784.784 0 1 1 0 1.568H6.784A.784.784 0 0 1 6 15.784zM6.114 19.817c0-.433.35-.784.784-.784h6.318a.784.784 0 1 1 0 1.568H6.898a.784.784 0 0 1-.784-.784z"
        fill="#fff"
      />
      <defs>
        <linearGradient id={gradientId} x1="1.5" y1="-1" x2="23.5" y2="28" gradientUnits="userSpaceOnUse">
          <stop stopColor="#6D93FF" />
          <stop offset="1" stopColor="#5A71F0" />
        </linearGradient>
      </defs>
    </svg>
  )
}
