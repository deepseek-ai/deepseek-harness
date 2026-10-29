/** Locale bundles for the built-in plugins settings section. */

/** Locale keys the section renders. */
export type PluginsSettingsLocaleKey = 'nav' | 'title' | 'intro' | 'tabs' | 'empty'

/** English copy. */
export const en: Record<PluginsSettingsLocaleKey, string> = {
  nav: 'Built-in plugins',
  title: 'Built-in plugins',
  intro: 'Inspect the plugins this deployment ships.',
  tabs: 'Plugin views',
  empty: 'This deployment exposes no plugin views.',
}

/** Simplified Chinese copy. */
export const zh: Record<PluginsSettingsLocaleKey, string> = {
  nav: '内置插件',
  title: '内置插件',
  intro: '查看内置部署的插件列表',
  tabs: '插件视图',
  empty: '本部署没有开放任何插件视图。',
}

/** Japanese copy, checked against the English keys. */
export const ja = {
  'nav': '組み込みプラグイン',
  'title': '組み込みプラグイン',
  'intro': 'このデプロイメントに含まれるプラグインを確認します。',
  'tabs': 'プラグインビュー',
  'empty': 'このデプロイメントにはプラグインビューがありません。',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  nav: 'Complementos integrados',
  title: 'Complementos integrados',
  intro: 'Inspeccione los complementos que incluye esta implementación.',
  tabs: 'Vistas de complementos',
  empty: 'Esta implementación no expone vistas de complementos.',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  nav: 'Plugins intégrés',
  title: 'Plugins intégrés',
  intro: 'Inspectez les plugins fournis par ce déploiement.',
  tabs: 'Vues des plugins',
  empty: "Ce déploiement n'expose aucune vue de plugin.",
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  nav: 'Integrierte Plugins',
  title: 'Integrierte Plugins',
  intro: 'Überprüfen Sie die Plugins, die mit dieser Bereitstellung geliefert werden.',
  tabs: 'Plugin-Ansichten',
  empty: 'Diese Bereitstellung stellt keine Plugin-Ansichten bereit.',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  nav: 'Встроенные плагины',
  title: 'Встроенные плагины',
  intro: 'Проверьте плагины, поставляемые в этом развертывании.',
  tabs: 'Просмотры плагинов',
  empty: 'Это развертывание не предоставляет никаких представлений плагинов.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  nav: 'Plug-ins integrados',
  title: 'Plug-ins integrados',
  intro: 'Inspecione os plug-ins fornecidos por esta implantação.',
  tabs: 'Visualizações de plug-in',
  empty: 'Esta implantação não expõe visualizações de plug-ins.',
} satisfies Record<keyof typeof en, string>
