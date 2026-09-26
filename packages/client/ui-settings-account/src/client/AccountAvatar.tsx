/** Shared account picture with an icon fallback for missing or unavailable images. */
import { useState } from 'react'
import { IconUserOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './AccountAvatar.module.css'

/**
 * Render a decorative avatar next to the account identity.
 * @param props - profile picture URL; absent while signed out or loading.
 * @returns picture or the default account icon.
 */
export function AccountAvatar({ url }: { url?: string | null | undefined }) {
  const [failedUrl, setFailedUrl] = useState<string>()
  return url && url !== failedUrl
    ? <img className={css.image} src={url} alt="" referrerPolicy="no-referrer" onError={() => { setFailedUrl(url) }} />
    : <IconUserOutlineMedium size={16} />
}
