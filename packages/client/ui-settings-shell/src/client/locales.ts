/** Locale bundles for the shell executor's settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type ShellSettingsLocaleKey =
  | 'title' | 'description'
  | 'timeoutMs' | 'timeoutMsHint' | 'maxOutputBytes' | 'maxOutputBytesHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<ShellSettingsLocaleKey, string> = {
  title: 'Shell',
  description: 'Limit how long each command may run and how much it may output.',
  timeoutMs: 'Command timeout (ms)',
  timeoutMsHint: 'How long one command may run before it is terminated.',
  maxOutputBytes: 'Output cap per stream (bytes)',
  maxOutputBytesHint: 'Output beyond this spills to a temporary file rather than being lost.',
  overridden: 'Overridden',
  reset: 'Reset to default',
  readOnly: 'This deployment stores settings read-only.',
  unavailable: 'This plugin is not loaded, so it cannot be configured right now.',
  save: 'Save',
  saving: 'Saving…',
  saveFailed: 'The deployment did not accept these values; they were left for you to correct.',
  invalidNumber: 'Enter a number, or leave blank to use the default.',
}

/** Simplified Chinese copy. */
export const zh: Record<ShellSettingsLocaleKey, string> = {
  title: '终端',
  description: '限制每条命令最多能跑多久、最多输出多少内容。',
  timeoutMs: '命令超时（毫秒）',
  timeoutMsHint: '单条命令允许运行多久，超时即终止。',
  maxOutputBytes: '单流输出上限（字节）',
  maxOutputBytesHint: '超出部分会转存到临时文件，而不是被丢弃。',
  overridden: '已覆盖',
  reset: '恢复默认',
  readOnly: '本部署的设置为只读。',
  unavailable: '该插件当前未加载，暂时无法配置。',
  save: '保存',
  saving: '保存中…',
  saveFailed: '本部署没有接受这些值，已保留供你修改。',
  invalidNumber: '请填数字；留空表示使用默认值。',
}

/**
 * The form frame's copy, read from this page's dictionary.
 * @param t - the page's locale reader.
 * @returns the labels the shared settings form renders.
 */
export function formLabels(t: (key: ShellSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': 'シェル',
  'description': '各コマンドの実行時間と出力量を制限します。',
  'timeoutMs': 'コマンドのタイムアウト (ms)',
  'timeoutMsHint': '1つのコマンドが強制終了されるまでに実行できる時間。',
  'maxOutputBytes': 'ストリームごとの出力上限 (バイト)',
  'maxOutputBytesHint': 'この上限を超えた出力は失われず、一時ファイルに書き出されます。',
  'overridden': '上書き済み',
  'reset': 'デフォルトに戻す',
  'readOnly': 'このデプロイでは設定が読み取り専用で保存されます。',
  'unavailable': 'このプラグインは読み込まれていないため、現在設定できません。',
  'save': '保存',
  'saving': '保存中…',
  'saveFailed': 'デプロイがこれらの値を受け付けませんでした。修正のため残されています。',
  'invalidNumber': '数値を入力するか、空欄のままにするとデフォルトが使用されます。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  title: 'Concha',
  description: 'Limite cuánto tiempo puede ejecutarse cada comando y cuánto puede generar.',
  timeoutMs: 'Tiempo de espera del comando (ms)',
  timeoutMsHint: 'Cuánto tiempo puede ejecutarse un comando antes de finalizar.',
  maxOutputBytes: 'Límite de salida por flujo (bytes)',
  maxOutputBytesHint: 'La salida más allá de esto se transfiere a un archivo temporal en lugar de perderse.',
  overridden: 'Anulado',
  reset: 'Restablecer los valores predeterminados',
  readOnly: 'Esta implementación almacena configuraciones de solo lectura.',
  unavailable: 'Este complemento no está cargado, por lo que no se puede configurar en este momento.',
  save: 'Guardar',
  saving: 'Guardando…',
  saveFailed: 'El despliegue no aceptó estos valores; quedaron para que usted los corrigiera.',
  invalidNumber: 'Ingrese un número o déjelo en blanco para usar el valor predeterminado.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  title: 'Coquille',
  description: "Limitez la durée d'exécution de chaque commande et le volume de résultats qu'elle peut générer.",
  timeoutMs: "Délai d'expiration de la commande (ms)",
  timeoutMsHint: "Combien de temps une commande peut s'exécuter avant d'être terminée.",
  maxOutputBytes: 'Limite de sortie par flux (octets)',
  maxOutputBytesHint: "La sortie au-delà de cela se déverse dans un fichier temporaire plutôt que d'être perdue.",
  overridden: 'Remplacé',
  reset: 'Réinitialiser aux valeurs par défaut',
  readOnly: 'Ce déploiement stocke les paramètres en lecture seule.',
  unavailable: "Ce plugin n'est pas chargé, il ne peut donc pas être configuré pour le moment.",
  save: 'Enregistrer',
  saving: 'Sauvegarde…',
  saveFailed: "Le déploiement n'a pas accepté ces valeurs ; ils vous ont été laissés à corriger.",
  invalidNumber: 'Entrez un numéro ou laissez ce champ vide pour utiliser la valeur par défaut.',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  title: 'Muschel',
  description: 'Begrenzen Sie, wie lange jeder Befehl ausgeführt werden darf und wie viel er ausgeben darf.',
  timeoutMs: 'Befehls-Timeout (ms)',
  timeoutMsHint: 'Wie lange ein Befehl ausgeführt werden darf, bevor er beendet wird.',
  maxOutputBytes: 'Ausgabeobergrenze pro Stream (Byte)',
  maxOutputBytesHint: 'Darüber hinausgehende Ausgaben werden in eine temporäre Datei übertragen und gehen nicht verloren.',
  overridden: 'Überschrieben',
  reset: 'Auf Standard zurücksetzen',
  readOnly: 'Diese Bereitstellung speichert Einstellungen schreibgeschützt.',
  unavailable: 'Dieses Plugin ist nicht geladen und kann daher derzeit nicht konfiguriert werden.',
  save: 'Speichern',
  saving: 'Speichern…',
  saveFailed: 'Die Bereitstellung hat diese Werte nicht akzeptiert. Sie mussten sie korrigieren.',
  invalidNumber: 'Geben Sie eine Zahl ein oder lassen Sie das Feld leer, um den Standardwert zu verwenden.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  title: 'Ракушка',
  description: 'Ограничьте продолжительность выполнения каждой команды и объем вывода.',
  timeoutMs: 'Таймаут команды (мс)',
  timeoutMsHint: 'Как долго может выполняться одна команда до ее завершения.',
  maxOutputBytes: 'Ограничение вывода на поток (байты)',
  maxOutputBytesHint: 'Вывод, выходящий за пределы этого, сохраняется во временный файл, а не теряется.',
  overridden: 'Переопределено',
  reset: 'Сбросить настройки по умолчанию',
  readOnly: 'В этом развертывании параметры сохраняются только для чтения.',
  unavailable: 'Этот плагин не загружен, поэтому его невозможно настроить прямо сейчас.',
  save: 'Сохранить',
  saving: 'Сохранение…',
  saveFailed: 'Развертывание не приняло эти значения; их оставили вам на исправление.',
  invalidNumber: 'Введите число или оставьте поле пустым, чтобы использовать значение по умолчанию.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  title: 'Concha',
  description: 'Limite quanto tempo cada comando pode ser executado e quanto ele pode gerar.',
  timeoutMs: 'Tempo limite do comando (ms)',
  timeoutMsHint: 'Quanto tempo um comando pode ser executado antes de ser encerrado.',
  maxOutputBytes: 'Limite de saída por stream (bytes)',
  maxOutputBytesHint: 'A saída além disso é transferida para um arquivo temporário em vez de ser perdida.',
  overridden: 'Substituído',
  reset: 'Redefinir para o padrão',
  readOnly: 'Esta implantação armazena configurações somente leitura.',
  unavailable: 'Este plugin não está carregado, portanto não pode ser configurado agora.',
  save: 'Salvar',
  saving: 'Salvando…',
  saveFailed: 'A implantação não aceitou esses valores; eles foram deixados para você corrigir.',
  invalidNumber: 'Insira um número ou deixe em branco para usar o padrão.',
} satisfies Record<keyof typeof en, string>
