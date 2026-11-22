/** Native element whose request state belongs to its connected document lifetime. */
import type { mountPairing, PairingRecovery } from './pairing.ts'
import type { pairingLocales, pairingMethodLabels } from './locales.ts'

interface PairingElement extends HTMLElement {
  connectedCallback(): void
  disconnectedCallback(): void
}

/**
 * Define the anonymous element from explicitly supplied browser code and public data.
 * Serialized into the public script; no runtime dependency may escape its parameters.
 * @param mount - instance-owned pairing interaction.
 * @param locales - public dictionaries selected by browser language.
 * @param labels - public request labels selected by browser language.
 * @param css - plugin-owned anonymous-page styles.
 * @param recovery - validated public timing and recovery limits.
 * @returns the registered element constructor.
 */
export function definePairingElement(
  mount: typeof mountPairing, locales: typeof pairingLocales, labels: typeof pairingMethodLabels, css: string, recovery: PairingRecovery,
): new () => PairingElement {
  const styles = Object.fromEntries(['pairing', 'panel', 'title', 'hint', 'message', 'countdown', 'code', 'feedback', 'button', 'primary']
    .map(name => [name, `dsh-device-pairing-${name}`]))

  return ((Element: new () => PairingElement) => {
    customElements.define('dsh-device-pairing', Element)
    return Element
  })(class extends HTMLElement {
    private dispose: (() => void) | undefined

    /** Mount once per connection; reconnection starts without a retained credential. */
    connectedCallback(): void {
      if (this.dispose !== undefined) return
      const view = this.ownerDocument.defaultView
      if (view === null) return
      const language = view.navigator.language.toLowerCase()
      const t = language.startsWith('zh') ? locales.zh : locales.en
      const label = labels[language.replace(/-.*/, '')] ?? labels.en
      this.dispose = mount(this, styles, t, label, {
        request: view.fetch.bind(view), navigate(url) { view.location.href = url },
      }, recovery)
      const style = this.ownerDocument.createElement('style')
      style.textContent = css
      this.prepend(style)
    }

    /** Release listeners, timers and requests when the method leaves the document. */
    disconnectedCallback(): void {
      this.dispose?.()
      this.dispose = undefined
      this.replaceChildren()
    }
  })
}
