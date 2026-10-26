/** Locale bundles for the agent loop's settings page. */

import type { SettingsFormLabels } from '@deepseek-ai/dsh-client-ui-primitives'

/** Locale keys the page renders. */
export type AgentLoopSettingsLocaleKey =
  | 'title' | 'description' | 'maxParallel' | 'maxParallelHint'
  | 'overridden' | 'reset' | 'readOnly' | 'unavailable'
  | 'save' | 'saving' | 'saveFailed' | 'invalidNumber'

/** English copy. */
export const en: Record<AgentLoopSettingsLocaleKey, string> = {
  title: 'Agent loop',
  description: 'Control how the Agent dispatches tool calls.',
  maxParallel: 'Parallel tool calls',
  maxParallelHint: 'Upper bound on parallel-safe calls running at once within one step.',
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
export const zh: Record<AgentLoopSettingsLocaleKey, string> = {
  title: 'Agent 循环',
  description: '控制 Agent 派发工具调用的方式。',
  maxParallel: '并行工具调用数',
  maxParallelHint: '同一步内最多同时运行多少个可并行的调用。',
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
export function formLabels(t: (key: AgentLoopSettingsLocaleKey) => string): SettingsFormLabels {
  return { unavailable: t('unavailable'), readOnly: t('readOnly'), saveFailed: t('saveFailed'), save: t('save'), saving: t('saving') }
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': 'エージェントループ',
  'description': 'エージェントのツール呼び出しのディスパッチ方法を制御します。',
  'maxParallel': '並列ツール呼び出し',
  'maxParallelHint': '1ステップ内で同時に実行される並列安全呼び出しの上限。',
  'overridden': '上書き済み',
  'reset': 'デフォルトにリセット',
  'readOnly': 'このデプロイメントでは設定は読み取り専用で保存されます。',
  'unavailable': 'このプラグインは読み込まれていないため、現在設定できません。',
  'save': '保存',
  'saving': '保存中…',
  'saveFailed': 'デプロイがこれらの値を受け付けませんでした。修正のために残されています。',
  'invalidNumber': '数値を入力するか、空欄のままにするとデフォルトが使用されます。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  title: 'Bucle de agente',
  description: 'Controle cómo el Agente distribuye las llamadas a la herramienta.',
  maxParallel: 'Llamadas a herramientas paralelas',
  maxParallelHint: 'Límite superior de llamadas seguras en paralelo que se ejecutan al mismo tiempo en un solo paso.',
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
  title: "Boucle d'agent",
  description: "Contrôlez la manière dont l'agent distribue les appels d'outil.",
  maxParallel: "Appels d'outils parallèles",
  maxParallelHint: 'Limite supérieure des appels parallèles sécurisés exécutés simultanément en une seule étape.',
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
  title: 'Agentenschleife',
  description: 'Steuern Sie, wie der Agent Toolaufrufe verteilt.',
  maxParallel: 'Parallele Werkzeugaufrufe',
  maxParallelHint: 'Obergrenze für parallelsichere Aufrufe, die gleichzeitig innerhalb eines Schritts ausgeführt werden.',
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
  title: 'Цикл агента',
  description: 'Управляйте тем, как агент распределяет вызовы инструментов.',
  maxParallel: 'Параллельные вызовы инструментов',
  maxParallelHint: 'Верхняя граница параллельных безопасных вызовов, выполняемых одновременно в течение одного шага.',
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
  title: 'Loop de agente',
  description: 'Controle como o Agente despacha chamadas de ferramenta.',
  maxParallel: 'Chamadas de ferramentas paralelas',
  maxParallelHint: 'Limite superior em chamadas paralelas seguras executadas ao mesmo tempo em uma etapa.',
  overridden: 'Substituído',
  reset: 'Redefinir para o padrão',
  readOnly: 'Esta implantação armazena configurações somente leitura.',
  unavailable: 'Este plugin não está carregado, portanto não pode ser configurado agora.',
  save: 'Salvar',
  saving: 'Salvando…',
  saveFailed: 'A implantação não aceitou esses valores; eles foram deixados para você corrigir.',
  invalidNumber: 'Insira um número ou deixe em branco para usar o padrão.',
} satisfies Record<keyof typeof en, string>
