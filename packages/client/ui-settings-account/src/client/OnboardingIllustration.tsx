/** Artwork variant matching the active theme's palette. */
import css from './DesktopOnboarding.module.css'

/**
 * @param props - light and dark artwork URLs, the active palette, and feature-owned geometry.
 * @returns the decorative artwork for that palette.
 */
export function OnboardingIllustration({ className = '', src, darkSrc, colorScheme }: {
  className?: string | undefined
  src: string
  darkSrc: string
  colorScheme: 'light' | 'dark'
}) {
  return <div className={`${css.illustration} ${className}`} aria-hidden="true">
    <img src={colorScheme === 'dark' ? darkSrc : src} alt="" />
  </div>
}
