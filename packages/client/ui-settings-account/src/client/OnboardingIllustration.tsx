/** Paired artwork follows the page's light and dark theme selectors. */
import css from './DesktopOnboarding.module.css'

/** @param props - artwork URLs and feature-owned geometry. @returns decorative theme variants. */
export function OnboardingIllustration({ className = '', src, darkSrc }: { className?: string | undefined; src: string; darkSrc: string }) {
  return <div className={`${css.illustration} ${className}`} aria-hidden="true">
    <img className={css.lightIllustration} src={src} alt="" />
    <img className={css.darkIllustration} src={darkSrc} alt="" />
  </div>
}
