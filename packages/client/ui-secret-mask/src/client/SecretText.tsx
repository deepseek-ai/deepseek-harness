/** Masked credential presentation with a per-value reveal control in interactive text. */
import { useState } from 'react'
import type { UserTextNodeProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import { MASK } from './credential-masks.ts'
import css from './SecretText.module.css'

const EYE_CONTOUR = 'M1.5 8C2.9 5.25 5.25 3.5 8 3.5C10.75 3.5 13.1 5.25 14.5 8C13.1 10.75 10.75 12.5 8 12.5C5.25 12.5 2.9 10.75 1.5 8Z'
const EYE_PATH = `${EYE_CONTOUR}M10 8C10 9.1 9.1 10 8 10C6.9 10 6 9.1 6 8C6 6.9 6.9 6 8 6C9.1 6 10 6.9 10 8Z`
/** The struck-through glyph drops the pupil so it stays distinct at text size. */
const EYE_OFF_PATH = `${EYE_CONTOUR}M2.5 2.5L13.5 13.5`
const MASK_RUNS = new RegExp(`(\\${MASK}+)`, 'u')

function EyeGlyph({ path }: { readonly path: string }) {
  return (
    <svg className={css.icon} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.3} strokeLinecap="round" aria-hidden="true">
      <path d={path} />
    </svg>
  )
}

/**
 * Split the masked form into kept text and mask runs. Mask runs keep their
 * characters for copying and assistive technology but draw centered marks,
 * because a font's own asterisk sits near the cap height.
 */
function MaskedText({ masked }: { readonly masked: string }) {
  let offset = 0
  return masked.split(MASK_RUNS).map((part) => {
    const key = offset
    offset += part.length
    if (part === '') return null
    return part.startsWith(MASK)
      ? <span key={key} className={css.mask}>{part}</span>
      : <span key={key}>{part}</span>
  })
}

type SecretTextProps = UserTextNodeProps<'secret'> & PropsLocale<typeof NS>

/**
 * Draw one credential masked; interactive text adds a control that reveals or hides this value.
 * Every mount, and every different original value at the same position, starts masked.
 * @param props - masked node, original spelling, interaction mode, and locale seat.
 * @returns an inline masked run with an optional reveal control.
 */
export function SecretText({ node, raw, interactive, t }: SecretTextProps) {
  // Holding the revealed value instead of a flag re-masks a different credential that reuses this element.
  const [revealedRaw, setRevealedRaw] = useState<string | undefined>()
  const revealed = interactive && revealedRaw === raw
  return (
    <span className={css.secret} data-secret="">
      <span className={css.value}>{revealed ? raw : <MaskedText masked={node.data.masked} />}</span>
      {interactive && (
        <button
          type="button"
          className={css.toggle}
          aria-pressed={revealed}
          aria-label={t(revealed ? 'secret.hide' : 'secret.reveal')}
          onClick={() => { setRevealedRaw(revealed ? undefined : raw) }}
        >
          <EyeGlyph path={revealed ? EYE_OFF_PATH : EYE_PATH} />
        </button>
      )}
    </span>
  )
}
