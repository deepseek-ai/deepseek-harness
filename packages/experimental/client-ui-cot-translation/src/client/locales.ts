/** Locale-owned copy for reasoning translation and its preferences. */
import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Dictionary namespace for this plugin. */
export const NS = 'cotTranslation'

/** English copy and key source. */
export const en = {
  provider: 'Translation service', google: 'Google', bing: 'Bing',
  deepseekAccount: 'DeepSeek Flash — account (paid)', deepseekOfficial: 'DeepSeek Flash — official API (paid)',
  providerUnavailableOption: '{provider} — unavailable',
  providerUnavailable: 'This provider is unavailable. Configure your DeepSeek account or official API provider, or choose an available service.',
  paidNotice: 'Each uncached fragment sends a separate paid DeepSeek Flash request through the selected account or official API credentials. Reopening reasoning reuses saved results; changing the provider, language, source text, or request settings may send a new paid request.',
  anonymousNotice: 'Bing and Google need no translation login or API key. Their anonymous endpoints may reject or limit requests.', targetLanguage: 'Target language',
  targetLanguageHint: 'auto follows the UI language; language codes such as zh, en, and ja also work.',
  privacy: 'Expanded reasoning is sent to the selected service. It may contain private code or conversation details.',
  translation: 'View translation', original: 'View original', retry: 'Retry', failed: 'Translation failed. Showing the original.',
  translating: 'Translating reasoning', invalidProvider: 'Choose a translation service.', invalidLanguage: 'Enter auto or a language code, such as zh, en, or ja.',
  overridden: 'Overridden', reset: 'Reset to default',
  unavailable: 'Translation preferences are unavailable.', readOnly: 'This deployment stores settings read-only.',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.', save: 'Save', saving: 'Saving…',
  copy: 'Copy', copied: 'Copied', codeTitle: 'Code block', wrap: 'Wrap lines', unwrap: 'Unwrap lines', footnotes: 'Footnotes',
}

/** Locale dictionary key union. */
export type CotTranslationKey = keyof typeof en

/** Chinese copy. */
export const zh: Record<CotTranslationKey, string> = {
  provider: '翻译服务', google: 'Google', bing: 'Bing',
  deepseekAccount: 'DeepSeek Flash · 账号（付费）', deepseekOfficial: 'DeepSeek Flash · 官方 API（付费）',
  providerUnavailableOption: '{provider} — 不可用',
  providerUnavailable: '此服务暂不可用，请配置 DeepSeek 账号或官方 API 服务，或选择可用的翻译服务',
  paidNotice: '每个未缓存片段都会通过所选账号或官方 API 凭据单独发送一次付费的 DeepSeek Flash 请求；重新展开会复用已保存的译文，更改服务、语言、原文或请求设置可能发送新的付费请求',
  anonymousNotice: 'Bing 和 Google 翻译无需额外登录或 API key，但匿名接口可能拒绝或限制请求', targetLanguage: '目标语言',
  targetLanguageHint: 'auto 使用界面语言；也可填写语言代码，例如 zh、en、ja',
  privacy: '展开的思考内容会发送给所选翻译服务，可能包含私有代码或对话细节。',
  translation: '查看译文', original: '查看原文', retry: '重试', failed: '翻译暂不可用，已显示原文',
  translating: '正在翻译思考内容', invalidProvider: '请选择翻译服务', invalidLanguage: '请填写 auto 或语言代码，例如 zh、en、ja',
  overridden: '已覆盖', reset: '恢复默认',
  unavailable: '翻译设置暂不可用', readOnly: '本部署的设置为只读',
  saveFailed: '本部署没有接受这些值，已保留供你修改', save: '保存', saving: '保存中…',
  copy: '复制', copied: '已复制', codeTitle: '代码块', wrap: '自动换行', unwrap: '不换行', footnotes: '脚注',
}

/**
 * Read shared form chrome from the plugin dictionary.
 * @param t - current locale reader.
 * @returns localized form labels.
 */
export function formLabels(t: (key: CotTranslationKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'provider': '翻訳サービス',
  'google': 'Google',
  'bing': 'Bing',
  'deepseekAccount': 'DeepSeek Flash — アカウント (有料)',
  'deepseekOfficial': 'DeepSeek Flash — 公式 API (有料)',
  'providerUnavailableOption': '{provider} — 利用不可',
  'providerUnavailable': 'このプロバイダーは利用できません。DeepSeek アカウントまたは公式 API プロバイダーを設定するか、利用可能なサービスを選択してください。',
  'paidNotice': 'キャッシュされていないフラグメントごとに、選択したアカウントまたは公式 API の認証情報を通じて、個別の有料 DeepSeek Flash リクエストが送信されます。推論を再度開くと保存済みの結果が再利用されますが、プロバイダー、言語、ソーステキスト、またはリクエスト設定を変更すると、新たな有料リクエストが送信される場合があります。',
  'anonymousNotice': 'Bing と Google は翻訳のログインや API キーが不要です。これらの匿名エンドポイントはリクエストを拒否したり制限したりする場合があります。',
  'targetLanguage': '翻訳先の言語',
  'targetLanguageHint': 'auto は UI の言語に従います。zh、en、ja などの言語コードも使用できます。',
  'privacy': '展開された推論は選択したサービスに送信されます。非公開のコードや会話の詳細が含まれている可能性があります。',
  'translation': '翻訳を表示',
  'original': '原文を表示',
  'retry': '再試行',
  'failed': '翻訳に失敗しました。原文を表示しています。',
  'translating': '推論を翻訳中',
  'invalidProvider': '翻訳サービスを選択してください。',
  'invalidLanguage': 'auto または zh、en、ja などの言語コードを入力してください。',
  'overridden': '上書き済み',
  'reset': 'デフォルトに戻す',
  'unavailable': '翻訳設定を利用できません。',
  'readOnly': 'このデプロイでは設定は読み取り専用で保存されます。',
  'saveFailed': 'このデプロイでは値が受け入れられませんでした。修正のために値はそのまま残されています。',
  'save': '保存',
  'saving': '保存中…',
  'copy': 'コピー',
  'copied': 'コピーしました',
  'codeTitle': 'コードブロック',
  'wrap': '折り返し',
  'unwrap': '折り返しを解除',
  'footnotes': '脚注',
} satisfies Record<keyof typeof en, string>
