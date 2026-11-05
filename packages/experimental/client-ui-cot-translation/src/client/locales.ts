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

/** Spanish dictionary, checked against the English keys. */
export const es = {
  provider: 'Servicio de traducción', google: 'google', bing: 'Bing',
  deepseekAccount: 'DeepSeek Flash — cuenta (pago)', deepseekOfficial: 'Flash DeepSeek: API oficial (de pago)',
  providerUnavailableOption: '{provider} — no disponible',
  providerUnavailable: 'Este proveedor no está disponible. Configura tu cuenta DeepSeek o proveedor oficial de API, o elige un servicio disponible.',
  paidNotice: 'Cada fragmento no almacenado en caché envía una solicitud Flash DeepSeek paga por separado a través de la cuenta seleccionada o las credenciales oficiales de API. El razonamiento de reapertura reutiliza los resultados guardados; cambiar el proveedor, el idioma, el texto fuente o la configuración de la solicitud puede enviar una nueva solicitud paga.',
  anonymousNotice: 'Bing y Google no necesitan inicio de sesión de traducción ni clave API. Sus puntos finales anónimos pueden rechazar o limitar solicitudes.', targetLanguage: 'Idioma de destino',
  targetLanguageHint: 'auto sigue el idioma de la interfaz de usuario; Los códigos de idioma como zh, en y ja también funcionan.',
  privacy: 'Se envía el razonamiento ampliado al servicio seleccionado. Puede contener código privado o detalles de la conversación.',
  translation: 'Ver traducción', original: 'Ver original', retry: 'Reintentar', failed: 'La traducción falló. Mostrando el original.',
  translating: 'Traducir razonamiento', invalidProvider: 'Elija un servicio de traducción.', invalidLanguage: 'Ingrese auto o un código de idioma, como zh, en o ja.',
  overridden: 'Anulado', reset: 'Restablecer los valores predeterminados',
  unavailable: 'Las preferencias de traducción no están disponibles.', readOnly: 'Esta implementación almacena configuraciones de solo lectura.',
  saveFailed: 'El despliegue no aceptó estos valores; quedaron para que usted los corrigiera.', save: 'Guardar', saving: 'Guardando…',
  copy: 'Copiar', copied: 'Copiado', codeTitle: 'Bloque de código', wrap: 'Ajustar líneas', unwrap: 'Desenvolver líneas', footnotes: 'Notas a pie de página',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  provider: 'Service de traduction', google: 'Google', bing: 'Bing',
  deepseekAccount: 'DeepSeek Flash — compte (payant)', deepseekOfficial: 'DeepSeek Flash — API officiel (payant)',
  providerUnavailableOption: '{provider} — indisponible',
  providerUnavailable: "Ce fournisseur n'est pas disponible. Configurez votre compte DeepSeek ou votre fournisseur officiel API, ou choisissez un service disponible.",
  paidNotice: "Chaque fragment non mis en cache envoie une demande Flash DeepSeek payante distincte via le compte sélectionné ou les informations d'identification officielles API. La réouverture du raisonnement réutilise les résultats enregistrés ; la modification du fournisseur, de la langue, du texte source ou des paramètres de la demande peut envoyer une nouvelle demande payante.",
  anonymousNotice: "Bing et Google n'ont pas besoin de connexion de traduction ni de clé API. Leurs points de terminaison anonymes peuvent rejeter ou limiter les demandes.", targetLanguage: 'Langue cible',
  targetLanguageHint: "auto suit la langue de l'interface utilisateur ; les codes de langue tels que zh, en et ja fonctionnent également.",
  privacy: 'Le raisonnement étendu est envoyé au service sélectionné. Il peut contenir du code privé ou des détails de conversation.',
  translation: 'Voir la traduction', original: "Voir l'original", retry: 'Réessayer', failed: "La traduction a échoué. Montrant l'original.",
  translating: 'Traduire le raisonnement', invalidProvider: 'Choisissez un service de traduction.', invalidLanguage: 'Saisissez auto ou un code de langue, tel que zh, en ou ja.',
  overridden: 'Remplacé', reset: 'Réinitialiser aux valeurs par défaut',
  unavailable: 'Les préférences de traduction ne sont pas disponibles.', readOnly: 'Ce déploiement stocke les paramètres en lecture seule.',
  saveFailed: "Le déploiement n'a pas accepté ces valeurs ; ils vous ont été laissés à corriger.", save: 'Enregistrer', saving: 'Sauvegarde…',
  copy: 'Copier', copied: 'Copié', codeTitle: 'Bloc de code', wrap: 'Activer le retour à la ligne', unwrap: 'Dérouler les lignes', footnotes: 'Notes de bas de page',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  provider: 'Übersetzungsdienst', google: 'Google', bing: 'Bing',
  deepseekAccount: 'DeepSeek Flash – Konto (kostenpflichtig)', deepseekOfficial: 'DeepSeek Flash – offizieller API (kostenpflichtig)',
  providerUnavailableOption: '{provider} – nicht verfügbar',
  providerUnavailable: 'Dieser Anbieter ist nicht verfügbar. Konfigurieren Sie Ihr DeepSeek-Konto oder Ihren offiziellen API-Anbieter oder wählen Sie einen verfügbaren Dienst.',
  paidNotice: 'Jedes nicht zwischengespeicherte Fragment sendet eine separate kostenpflichtige DeepSeek-Flash-Anfrage über das ausgewählte Konto oder die offiziellen API-Anmeldeinformationen. Beim erneuten Öffnen der Argumentation werden gespeicherte Ergebnisse wiederverwendet. Wenn Sie den Anbieter, die Sprache, den Quelltext oder die Anfrageeinstellungen ändern, wird möglicherweise eine neue kostenpflichtige Anfrage gesendet.',
  anonymousNotice: 'Für Bing und Google ist weder ein Übersetzungs-Login noch ein API-Schlüssel erforderlich. Ihre anonymen Endpunkte können Anfragen ablehnen oder einschränken.', targetLanguage: 'Zielsprache',
  targetLanguageHint: 'folgt automatisch der UI-Sprache; Sprachcodes wie zh, en und ja funktionieren ebenfalls.',
  privacy: 'Die erweiterte Begründung wird an den ausgewählten Dienst gesendet. Es kann private Code- oder Konversationsdetails enthalten.',
  translation: 'Übersetzung ansehen', original: 'Original ansehen', retry: 'Erneut versuchen', failed: 'Die Übersetzung ist fehlgeschlagen. Zeigt das Original.',
  translating: 'Argumentation übersetzen', invalidProvider: 'Wählen Sie einen Übersetzungsdienst.', invalidLanguage: 'Geben Sie auto oder einen Sprachcode ein, z. B. zh, en oder ja.',
  overridden: 'Überschrieben', reset: 'Auf Standard zurücksetzen',
  unavailable: 'Übersetzungseinstellungen sind nicht verfügbar.', readOnly: 'Diese Bereitstellung speichert Einstellungen schreibgeschützt.',
  saveFailed: 'Die Bereitstellung hat diese Werte nicht akzeptiert. Sie mussten sie korrigieren.', save: 'Speichern', saving: 'Speichern…',
  copy: 'Kopieren', copied: 'Kopiert', codeTitle: 'Codeblock', wrap: 'Zeilen umbrechen', unwrap: 'Zeilen abwickeln', footnotes: 'Fußnoten',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  provider: 'Услуги перевода', google: 'Гугл', bing: 'Бинг',
  deepseekAccount: 'DeepSeek Flash — аккаунт (платный)', deepseekOfficial: 'DeepSeek Flash — официальный API (платный)',
  providerUnavailableOption: '{provider} — недоступен',
  providerUnavailable: 'Этот провайдер недоступен. Настройте свою учетную запись DeepSeek или официального провайдера API или выберите доступную услугу.',
  paidNotice: 'Каждый некэшированный фрагмент отправляет отдельный платный запрос DeepSeek Flash через выбранную учетную запись или официальные учетные данные API. При повторном открытии рассуждений повторно используются сохраненные результаты; изменение провайдера, языка, исходного текста или настроек запроса может привести к отправке нового платного запроса.',
  anonymousNotice: 'Bing и Google не требуют входа в систему для перевода или ключа API. Их анонимные конечные точки могут отклонять или ограничивать запросы.', targetLanguage: 'Целевой язык',
  targetLanguageHint: 'автоматически следует языку пользовательского интерфейса; коды языков, такие как zh, en и ja, также работают.',
  privacy: 'Развернутое обоснование отправляется в выбранную службу. Он может содержать личный код или детали разговора.',
  translation: 'Посмотреть перевод', original: 'Посмотреть оригинал', retry: 'Повторить', failed: 'Перевод не удался. Показываю оригинал.',
  translating: 'Перевод рассуждений', invalidProvider: 'Выберите услугу перевода.', invalidLanguage: 'Введите auto или код языка, например zh, en или ja.',
  overridden: 'Переопределено', reset: 'Сбросить настройки по умолчанию',
  unavailable: 'Настройки перевода недоступны.', readOnly: 'В этом развертывании параметры сохраняются только для чтения.',
  saveFailed: 'Развертывание не приняло эти значения; их оставили вам на исправление.', save: 'Сохранить', saving: 'Сохранение…',
  copy: 'Копировать', copied: 'Скопировано', codeTitle: 'Блок кода', wrap: 'Переносить строки', unwrap: 'Развернуть линии', footnotes: 'Сноски',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  provider: 'Serviço de tradução', google: 'Google', bing: 'Google',
  deepseekAccount: 'DeepSeek Flash — conta (paga)', deepseekOfficial: 'DeepSeek Flash — oficial API (pago)',
  providerUnavailableOption: '{provider} — indisponível',
  providerUnavailable: 'Este provedor não está disponível. Configure sua conta DeepSeek ou provedor API oficial ou escolha um serviço disponível.',
  paidNotice: 'Cada fragmento não armazenado em cache envia uma solicitação Flash DeepSeek paga separada por meio da conta selecionada ou das credenciais API oficiais. A reabertura do raciocínio reutiliza resultados salvos; alterar o provedor, o idioma, o texto fonte ou as configurações da solicitação pode enviar uma nova solicitação paga.',
  anonymousNotice: 'O Bing e o Google não precisam de login de tradução ou chave API. Seus endpoints anônimos podem rejeitar ou limitar solicitações.', targetLanguage: 'Idioma alvo',
  targetLanguageHint: 'auto segue o idioma da UI; códigos de idioma como zh, en e ja também funcionam.',
  privacy: 'O raciocínio expandido é enviado ao serviço selecionado. Pode conter código privado ou detalhes da conversa.',
  translation: 'Ver tradução', original: 'Ver original', retry: 'Tentar novamente', failed: 'A tradução falhou. Mostrando o original.',
  translating: 'Traduzindo o raciocínio', invalidProvider: 'Escolha um serviço de tradução.', invalidLanguage: 'Insira auto ou um código de idioma, como zh, en ou ja.',
  overridden: 'Substituído', reset: 'Redefinir para o padrão',
  unavailable: 'As preferências de tradução não estão disponíveis.', readOnly: 'Esta implantação armazena configurações somente leitura.',
  saveFailed: 'A implantação não aceitou esses valores; eles foram deixados para você corrigir.', save: 'Salvar', saving: 'Salvando…',
  copy: 'Copiar', copied: 'Copiado', codeTitle: 'Bloco de código', wrap: 'Quebrar linhas', unwrap: 'Desembrulhar linhas', footnotes: 'Notas de rodapé',
} satisfies Record<keyof typeof en, string>
