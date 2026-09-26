/** Fixed-palette artwork for sidebar guide entries. */
import type { IconProps } from './icons/props.ts'

/**
 * Render fixed-palette artwork for a sidebar guide entry.
 * @param props - canvas size and layout class supplied by the guide.
 * @returns an ornamental SVG hidden from assistive technology.
 */
export function GuideArtworkBrowser({ size = 36, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.9995 28.1465C23.6034 28.1465 28.1461 23.6038 28.1461 18C28.1461 12.3963 23.6034 7.85352 17.9995 7.85352C12.3958 7.85352 7.85303 12.3963 7.85303 18C7.85303 23.6038 12.3958 28.1465 17.9995 28.1465Z" stroke="#539CFA" strokeWidth="2" />
      <path d="M8.57764 18H27.4211" stroke="#539CFA" strokeWidth="2" strokeLinecap="square" />
      <path d="M17.999 28.1467C20.0576 28.1467 21.6228 23.6039 21.6228 18C21.6228 12.3963 20.0576 7.85352 17.999 7.85352" stroke="#539CFA" strokeWidth="2" />
      <path d="M17.9992 28.1467C15.9407 28.1467 14.3755 23.6039 14.3755 18C14.3755 12.3963 15.9407 7.85352 17.9992 7.85352" stroke="#539CFA" strokeWidth="2" />
    </svg>
  )
}

/**
 * Render fixed-palette artwork for a sidebar guide entry.
 * @param props - canvas size and layout class supplied by the guide.
 * @returns an ornamental SVG hidden from assistive technology.
 */
export function GuideArtworkFiles({ size = 36, className }: IconProps) {
  return (
    <svg width={size} height={size} className={className} aria-hidden="true" viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M10.7603 27.922H24.6817C26.3441 27.922 27.1753 27.922 27.8102 27.5984C28.3687 27.3139 28.8228 26.8598 29.1074 26.3012C29.4309 25.6663 29.4309 24.8351 29.4309 23.1727V15.4936" stroke="#FFCD78" strokeWidth="1.97886" />
      <path d="M13.1597 8.07812C13.4182 8.07818 13.6727 8.14336 13.8989 8.26855L16.7554 9.84961C16.9817 9.97485 17.2369 10.041 17.4956 10.041H26.106C26.9492 10.0412 27.6323 10.7251 27.6323 11.5684V24.5371C27.6323 25.3805 26.9483 26.0645 26.105 26.0645H8.09619C7.25281 26.0645 6.56884 25.3805 6.56885 24.5371V9.60449C6.56909 8.76133 7.25297 8.07812 8.09619 8.07812H13.1597ZM9.81592 14.5508V16.5293H24.3999V14.5508H9.81592Z" fill="#FFBC4D" />
    </svg>
  )
}
