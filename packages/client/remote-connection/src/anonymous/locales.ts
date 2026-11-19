/** Anonymous pairing copy available before the application locale service. */

const en = {
  pairTitle: 'Pair this device',
  pairHint: 'After requesting, open Settings → Remote connection on another signed-in device. Match the pairing code and approve to sign in here automatically.',
  pairCreating: 'Requesting approval…',
  pairWaiting: 'Waiting for approval…',
  pairCancelling: 'Cancelling this request…',
  pairReplacing: 'Cancelling the previous request before requesting again…',
  pairChecking: 'Checking sign-in status…',
  pairRecovering: 'Reconnecting automatically…',
  pairRateLimited: 'Too many requests. Retrying shortly…',
  pairRateLimitError: 'Too many requests. Wait a moment, then request again.',
  pairCheckError: 'Could not confirm sign-in. Check your connection, then request again.',
  pairCode: 'Pairing code',
  pairRemaining: 'Expires in {time}',
  pairDenied: 'The request was denied. You can request again.',
  pairExpired: 'The request expired. Request again.',
  pairError: 'Could not complete pairing. Check your connection, then request again.',
  pairCreateError: 'Could not request pairing. Check your connection, then request again.',
  pairCancel: 'Cancel request',
  pairAgain: 'Request again',
} as const

/** Stable keys shared by the anonymous pairing translations. */
export type PairingLocaleKey = keyof typeof en

const zh: Record<PairingLocaleKey, string> = {
  pairTitle: '配对此设备',
  pairHint: '申请后，在另一台已登录设备的“设置 → 远程连接”核对配对码并批准，此设备将自动登录。',
  pairCreating: '正在申请配对…',
  pairWaiting: '正在等待批准…',
  pairCancelling: '正在取消申请…',
  pairReplacing: '正在取消原申请，随后重新申请…',
  pairChecking: '正在确认登录状态…',
  pairRecovering: '正在自动重新连接…',
  pairRateLimited: '请求过于频繁，稍后自动重试…',
  pairRateLimitError: '请求过于频繁，请稍后重新申请',
  pairCheckError: '无法确认登录状态，请检查网络后重新申请',
  pairCode: '配对码',
  pairRemaining: '剩余时间：{time}',
  pairDenied: '申请已被拒绝，可以重新申请',
  pairExpired: '申请已过期，请重新申请',
  pairError: '无法完成配对，请检查网络后重新申请',
  pairCreateError: '无法申请配对，请检查网络后重新申请',
  pairCancel: '取消申请',
  pairAgain: '重新申请',
}

/** Public dictionaries embedded in the anonymous script before application startup. */
export const pairingLocales = { en, zh }

/** Labels for the anonymous method and its initial request action. */
export const pairingMethodLabels: Readonly<Record<string, string> & { en: string }> = {
  en: 'Request to pair', zh: '申请配对', de: 'Kopplung anfordern', es: 'Solicitar vinculación',
  fr: 'Demander l’association', ja: 'ペアリングを申請', pt: 'Solicitar pareamento', ru: 'Запросить сопряжение',
}
