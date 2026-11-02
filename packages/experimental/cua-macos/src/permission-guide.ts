/** macOS permission guide copy and private native request parameters. */
import { z } from 'zod'
import type { CuaBackend } from '@deepseek-ai/dsh-cua'

/** Native-only fields for opening the selected privacy pane. */
export const PermissionSettingsParameters = z.object({ settingsMessage: z.string().min(1) })
/** Native-only guide fields, validated again by the Swift request parser. */
export const PermissionGuideParameters = PermissionSettingsParameters.extend({
  instruction: z.string().min(1), backLabel: z.string().min(1), finderLabel: z.string().min(1),
  unavailableMessage: z.string().min(1), pollIntervalMs: z.number().int().min(100).max(2 ** 31 - 1),
})

const en = {
  instruction: 'Drag {application} to the list above to allow {permission}',
  backLabel: 'Back',
  finderLabel: 'Show in Finder',
  unavailableMessage: 'Application unavailable. Enable Computer Use again and retry.',
  settingsMessage: 'Open System Settings > Privacy & Security > {permission} manually.',
  accessibility: 'Accessibility',
  screenRecording: 'Screen Recording',
}

const zh = {
  instruction: '将 {application} 拖入上方列表以允许{permission}',
  backLabel: '返回',
  finderLabel: '在 Finder 中显示',
  unavailableMessage: '找不到此应用。请重新启用 Computer Use 后重试',
  settingsMessage: '请手动打开系统设置 > 隐私与安全性 > {permission}',
  accessibility: '辅助功能',
  screenRecording: '屏幕录制',
} satisfies typeof en

const ja = {
  instruction: '{permission}を許可するには、{application}を上の一覧にドラッグしてください',
  backLabel: '戻る',
  finderLabel: 'Finder で表示',
  unavailableMessage: 'アプリが見つかりません。Computer Use を再度有効にしてください。',
  settingsMessage: 'システム設定 > プライバシーとセキュリティ > {permission} を開いてください。',
  accessibility: 'アクセシビリティ',
  screenRecording: '画面収録',
} satisfies typeof en

const es = {
  instruction: 'Arrastra {application} a la lista de arriba para permitir {permission}',
  backLabel: 'Volver',
  finderLabel: 'Mostrar en Finder',
  unavailableMessage: 'Aplicación no disponible. Vuelve a activar Computer Use e inténtalo de nuevo.',
  settingsMessage: 'Abre Configuración del sistema > Privacidad y seguridad > {permission}.',
  accessibility: 'Accesibilidad',
  screenRecording: 'Grabación de pantalla',
} satisfies typeof en

const fr = {
  instruction: 'Glissez {application} dans la liste ci-dessus pour autoriser {permission}',
  backLabel: 'Retour',
  finderLabel: 'Afficher dans le Finder',
  unavailableMessage: 'Application introuvable. Réactivez Computer Use et réessayez.',
  settingsMessage: 'Ouvrez Réglages Système > Confidentialité et sécurité > {permission}.',
  accessibility: 'Accessibilité',
  screenRecording: "Enregistrement d'écran",
} satisfies typeof en

const de = {
  instruction: 'Ziehe {application} in die Liste oben, um {permission} zu erlauben',
  backLabel: 'Zurück',
  finderLabel: 'Im Finder anzeigen',
  unavailableMessage: 'Anwendung nicht verfügbar. Aktiviere Computer Use erneut.',
  settingsMessage: 'Öffne Systemeinstellungen > Datenschutz & Sicherheit > {permission}.',
  accessibility: 'Barrierefreiheit',
  screenRecording: 'Bildschirmaufzeichnung',
} satisfies typeof en

const ru = {
  instruction: 'Перетащите {application} в список выше, чтобы разрешить {permission}',
  backLabel: 'Назад',
  finderLabel: 'Показать в Finder',
  unavailableMessage: 'Приложение недоступно. Снова включите Computer Use и повторите попытку.',
  settingsMessage: 'Откройте Системные настройки > Конфиденциальность и безопасность > {permission}.',
  accessibility: 'Доступность',
  screenRecording: 'Запись экрана',
} satisfies typeof en

const pt = {
  instruction: 'Arraste {application} para a lista acima para permitir {permission}',
  backLabel: 'Voltar',
  finderLabel: 'Mostrar no Finder',
  unavailableMessage: 'Aplicativo indisponível. Ative Computer Use novamente e tente de novo.',
  settingsMessage: 'Abra Ajustes do Sistema > Privacidade e Segurança > {permission}.',
  accessibility: 'Acessibilidade',
  screenRecording: 'Gravação de tela',
} satisfies typeof en

const dictionaries = new Map<string, typeof en>(Object.entries({ en, zh, ja, es, fr, de, ru, pt }))

/**
 * Resolve native permission copy from the Client language; unsupported languages use English.
 * @param pollIntervalMs Interval between native guide permission and position checks.
 * @returns Provider-owned parameters for the selected permission action.
 */
export function createPermissionParameters(pollIntervalMs: number): CuaBackend['permissionParameters'] {
  return (method, permission, locale) => {
    const language = locale.toLowerCase().replace(/-.*/, '')
    const text = dictionaries.get(language) ?? en
    const settingsMessage = text.settingsMessage.replace('{permission}', text[permission])
    if (method === 'openPermissionSettings') return { permission, settingsMessage }
    return { permission, settingsMessage, pollIntervalMs,
      instruction: text.instruction.replace('{permission}', text[permission]),
      backLabel: text.backLabel, finderLabel: text.finderLabel, unavailableMessage: text.unavailableMessage }
  }
}
