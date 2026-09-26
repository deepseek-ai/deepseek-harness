/**
 * Fixed-palette plugin artwork for the plugin management surfaces. Unlike the
 * ic_ds_* set these glyphs carry their own brand colors and gradients instead
 * of riding currentColor; all draw on a 36×36 viewBox and take {size, className}.
 */
import { useId } from 'react'
import type { IconProps } from './icons/props.ts'

/**
 * A per-instance SVG def id prefix: the artwork repeats across cards and rows,
 * and duplicate document ids would make every `url(#…)` resolve to the first instance.
 */
const useArtworkId = (): string => `dsh_plugin_art_${useId().replaceAll(':', '')}`

/** Light-blue terminal artwork shared by plugin cards and sidebar guide entries. */
export const PluginArtworkTerminal = ({ size = 36, className }: IconProps) => (
  <svg width={size} height={size} className={className} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
    <path d="M10 11L16.606 17.606C16.6841 17.6841 16.6841 17.8107 16.606 17.8888L10 24.4948" stroke="#679EFE" strokeWidth="3.5" />
    <path d="M20.1211 24.4946H26.8685" stroke="#679EFE" strokeWidth="3.5" />
  </svg>
)

/** Agent-loop plugin artwork (four leaves circling a center). */
export const PluginArtworkLoop = ({ size = 36, className }: IconProps) => {
  const uid = useArtworkId()
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M18.0486 28.4901C12.0858 28.4901 7.25195 23.6562 7.25195 17.6934C13.2148 17.6934 18.0486 22.5272 18.0486 28.4901Z" fill="#A797FC" />
      <path d="M18.0486 6.89667C12.0858 6.89667 7.25195 11.7305 7.25195 17.6934C13.2148 17.6934 18.0486 12.8595 18.0486 6.89667Z" fill={`url(#${uid}a)`} />
      <path d="M18.0485 28.4901C24.0114 28.4901 28.8452 23.6562 28.8452 17.6934C22.8824 17.6934 18.0485 22.5272 18.0485 28.4901Z" fill="#4561EE" />
      <path d="M18.0485 6.89667C24.0114 6.89667 28.8452 11.7305 28.8452 17.6934C22.8824 17.6934 18.0485 12.8595 18.0485 6.89667Z" fill="#658EFF" />
      <defs>
        <linearGradient id={`${uid}a`} x1="16.7911" y1="16.1655" x2="8.98192" y2="8.74289" gradientUnits="userSpaceOnUse">
          <stop stopColor="#A23AE7" />
          <stop offset="1" stopColor="#E2E2E2" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/** Subagent plugin artwork (two stacked rounded squares); also marks every row inside a bundle. */
export const PluginArtworkSubagent = ({ size = 36, className }: IconProps) => {
  const uid = useArtworkId()
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="14.9893" y="15.1877" width="12.2365" height="12.2365" rx="2" fill={`url(#${uid}a)`} fillOpacity="0.8" />
      <rect x="8.87109" y="9.0697" width="12.2365" height="12.2365" rx="2" fill={`url(#${uid}b)`} fillOpacity="0.8" />
      <defs>
        <linearGradient id={`${uid}a`} x1="21.1075" y1="15.1877" x2="21.1075" y2="27.4243" gradientUnits="userSpaceOnUse">
          <stop stopColor="#45E7A4" />
          <stop offset="1" stopColor="#05909D" />
        </linearGradient>
        <linearGradient id={`${uid}b`} x1="14.9894" y1="9.0697" x2="14.9894" y2="21.3063" gradientUnits="userSpaceOnUse">
          <stop stopColor="#69B9FF" />
          <stop offset="1" stopColor="#324DE2" />
        </linearGradient>
      </defs>
    </svg>
  )
}

/**
 * Web-search plugin artwork (conic-gradient ring and handle). SVG has no
 * native conic gradient, so the ring clips an HTML div painted with CSS
 * `conic-gradient` — the same emulation Figma exports; it renders inline in
 * the browser UI but would stay empty in an `<img>` or mask context.
 */
export const PluginArtworkSearch = ({ size = 36, className }: IconProps) => {
  const uid = useArtworkId()
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M26.5362 26.9865L22.3813 22.8317" stroke="#2F2295" strokeWidth="3" />
      <g clipPath={`url(#${uid}ring)`}>
        <g transform="matrix(0.0119394 -0.00173904 0.00173904 0.0119394 15.7661 16.2159)">
          <foreignObject x="-958.94" y="-958.94" width="1917.88" height="1917.88">
            <div
              style={{
                background: 'conic-gradient(from 90deg, rgb(65, 225, 172) 0deg, rgb(85, 71, 210) 62.0619deg, rgb(65, 225, 172) 360deg)',
                height: '100%',
                width: '100%',
              }}
            />
          </foreignObject>
        </g>
      </g>
      <defs>
        <clipPath id={`${uid}ring`}>
          <path d="M21.9717 16.2159H19.9717C19.9717 18.5386 18.0888 20.4215 15.7661 20.4215V22.4215V24.4215C20.2979 24.4215 23.9717 20.7478 23.9717 16.2159H21.9717ZM15.7661 22.4215V20.4215C13.4434 20.4215 11.5605 18.5386 11.5605 16.2159H9.56055H7.56055C7.56055 20.7478 11.2343 24.4215 15.7661 24.4215V22.4215ZM9.56055 16.2159H11.5605C11.5605 13.8933 13.4434 12.0104 15.7661 12.0104V10.0104V8.01038C11.2343 8.01038 7.56055 11.6841 7.56055 16.2159H9.56055ZM15.7661 10.0104V12.0104C18.0888 12.0104 19.9717 13.8933 19.9717 16.2159H21.9717H23.9717C23.9717 11.6841 20.2979 8.01038 15.7661 8.01038V10.0104Z" />
        </clipPath>
      </defs>
    </svg>
  )
}

/** Default plugin artwork for plugins without one of their own (connector blocks and a node). */
export const PluginArtworkDefault = ({ size = 36, className }: IconProps) => {
  const uid = useArtworkId()
  return (
    <svg width={size} height={size} className={className} viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M24.6294 8.63696C26.2862 8.63705 27.6294 9.98016 27.6294 11.637V12.7825C27.6292 14.4391 26.2861 15.7824 24.6294 15.7825H23.4839C22.6519 15.7825 21.5454 16.3459 21.5454 17.1778V18.1573C21.5454 18.7757 22.216 19.1966 22.8345 19.1965H24.6294C26.2861 19.1965 27.6292 20.5398 27.6294 22.1965V23.9924C27.6292 25.6491 26.2861 26.9924 24.6294 26.9924H22.8345C21.1778 26.9924 19.8347 25.649 19.8345 23.9924V22.1965C19.8345 21.7148 19.4957 21.2327 19.014 21.2327H16.4792C15.7975 21.2327 15.3374 22.0061 15.3374 22.6877V23.8333C15.3373 25.49 13.9942 26.8333 12.3374 26.8333H11.1919C9.53509 26.8333 8.19198 25.49 8.19189 23.8333V22.6877C8.19189 21.0309 9.53504 19.6877 11.1919 19.6877H12.3374C13.1964 19.6877 14.3999 19.0959 14.3999 18.2369V16.0185C14.3999 14.9518 15.2646 14.0872 16.3312 14.0872H19.435C20.0596 14.0872 20.484 13.4071 20.4839 12.7825V11.637C20.4839 9.98011 21.827 8.63696 23.4839 8.63696H24.6294ZM13.4116 11.2468C13.4116 12.6882 12.2431 13.8567 10.8018 13.8567C9.36037 13.8567 8.19189 12.6882 8.19189 11.2468C8.19189 9.80544 9.36037 8.63696 10.8018 8.63696C12.2431 8.63696 13.4116 9.80544 13.4116 11.2468Z" fill={`url(#${uid}a)`} />
      <defs>
        <linearGradient id={`${uid}a`} x1="15.1481" y1="9.94188" x2="15.1481" y2="13.6375" gradientUnits="userSpaceOnUse">
          <stop stopColor="#54ECE7" />
          <stop offset="1" stopColor="#658EFF" />
        </linearGradient>
      </defs>
    </svg>
  )
}
