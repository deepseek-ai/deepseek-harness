/** `open-in-app` namespace dictionaries: the workspace split button and the document-preview path controls. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'open-in-app'

/** Application labels shared verbatim by both dictionaries (product names). */
const PRODUCT_NAMES = {
  'app.cursor': 'Cursor',
  'app.vscode': 'VS Code',
  'app.vscodeinsiders': 'VS Code Insiders',
  'app.windsurf': 'Windsurf',
  'app.zed': 'Zed',
  'app.sublimetext': 'Sublime Text',
  'app.xcode': 'Xcode',
  'app.androidstudio': 'Android Studio',
  'app.intellij': 'IntelliJ IDEA',
  'app.pycharm': 'PyCharm',
  'app.webstorm': 'WebStorm',
  'app.phpstorm': 'PhpStorm',
  'app.goland': 'GoLand',
  'app.rider': 'Rider',
  'app.rustrover': 'RustRover',
  'app.fork': 'Fork',
  'app.sourcetree': 'Sourcetree',
  'app.github': 'GitHub Desktop',
  'app.tower': 'Tower',
  'app.gitkraken': 'GitKraken',
  'app.smartgit': 'SmartGit',
  'app.sublimemerge': 'Sublime Merge',
  'app.ghostty': 'Ghostty',
  'app.warp': 'Warp',
  'app.iterm': 'iTerm2',
  'app.kitty': 'kitty',
  'app.windowsterminal': 'Windows Terminal',
  'app.gitbash': 'Git Bash',
  'app.gnometerminal': 'GNOME Terminal',
  'app.konsole': 'Konsole',
} as const

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'open.title': '用 {app} 打开',
  'path.appDefault': '{app}（默认）',
  'path.appsError': '无法获取应用列表',
  'shortcut.busy': '正在打开工作区',
  'shortcut.unavailable': '当前工作区或本地应用不可用',
  'open.tooltip': '在本地打开',
  'path.open': '打开',
  'path.more': '更多打开方式',
  'path.reveal': '显示文件位置',
  'path.opened': '已在其它设备打开',
  'path.revealed': '已在其它设备显示文件位置',
  'path.openError': '打开失败，请重试',
  'path.revealError': '无法显示文件位置，请重试',
  ...PRODUCT_NAMES,
  'app.finder': '访达',
  'app.explorer': '文件资源管理器',
  'app.filemanager': '文件管理器',
  'app.terminal': '终端',
} as const

/** English dictionary, key-identical to the Chinese source of truth. */
export const en: Record<OpenInAppKey, string> = {
  'open.title': 'Open in {app}',
  'path.appDefault': '{app} (default)',
  'path.appsError': 'Could not load applications',
  'shortcut.busy': 'Opening workspace',
  'shortcut.unavailable': 'Current workspace or local application unavailable',
  'open.tooltip': 'Open locally',
  'path.open': 'Open',
  'path.more': 'More ways to open',
  'path.reveal': 'Show file location',
  'path.opened': 'Opened on another device',
  'path.revealed': 'File location shown on another device',
  'path.openError': 'Could not open. Try again.',
  'path.revealError': 'Could not show the file location. Try again.',
  ...PRODUCT_NAMES,
  'app.finder': 'Finder',
  'app.explorer': 'File Explorer',
  'app.filemanager': 'Files',
  'app.terminal': 'Terminal',
}

/** Key domain of the `open-in-app` namespace (zh is the source of truth). */
export type OpenInAppKey = keyof typeof zh

/** Japanese copy, checked against the English keys. */
export const ja = {
  ...PRODUCT_NAMES,
  'open.title': '{app}で開く',
  'path.appDefault': '{app}（デフォルト）',
  'path.appsError': 'アプリケーションを読み込めませんでした',
  'shortcut.busy': 'ワークスペースを開いています',
  'shortcut.unavailable': '現在のワークスペースまたはローカルアプリケーションを利用できません',
  'open.tooltip': 'ローカルで開く',
  'path.open': '開く',
  'path.more': 'その他の開き方',
  'path.reveal': 'ファイルの場所を表示',
  'path.opened': '別のデバイスで開きました',
  'path.revealed': '別のデバイスでファイルの場所を表示しました',
  'path.openError': '開けませんでした。もう一度お試しください。',
  'path.revealError': 'ファイルの場所を表示できませんでした。もう一度お試しください。',
  'app.finder': 'Finder',
  'app.explorer': 'エクスプローラー',
  'app.filemanager': 'ファイル',
  'app.terminal': 'ターミナル',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'open.title': 'Abrir en {app}',
  'path.appDefault': '{app} (predeterminado)',
  'path.appsError': 'No se pudieron cargar aplicaciones',
  'shortcut.busy': 'Abrir espacio de trabajo',
  'shortcut.unavailable': 'El espacio de trabajo actual o la aplicación local no están disponibles',
  'open.tooltip': 'Abierto localmente',
  'path.open': 'Abrir',
  'path.more': 'Más formas de abrir',
  'path.reveal': 'Mostrar ubicación del archivo',
  'path.opened': 'Abierto en otro dispositivo',
  'path.revealed': 'Ubicación del archivo mostrada en otro dispositivo',
  'path.openError': 'No se pudo abrir. Intentar otra vez.',
  'path.revealError': 'No se pudo mostrar la ubicación del archivo. Intentar otra vez.',
  ...PRODUCT_NAMES,
  'app.finder': 'Finder',
  'app.explorer': 'Explorador de archivos',
  'app.filemanager': 'Archivos',
  'app.terminal': 'terminales',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'open.title': 'Ouvrir dans {app}',
  'path.appDefault': '{app} (par défaut)',
  'path.appsError': 'Impossible de charger les applications',
  'shortcut.busy': "Ouverture de l'espace de travail",
  'shortcut.unavailable': 'Espace de travail actuel ou application locale indisponible',
  'open.tooltip': 'Ouvrir localement',
  'path.open': 'Ouvrir',
  'path.more': "Plus de façons d'ouvrir",
  'path.reveal': "Afficher l'emplacement du fichier",
  'path.opened': 'Ouvert sur un autre appareil',
  'path.revealed': 'Emplacement du fichier affiché sur un autre appareil',
  'path.openError': "Impossible d'ouvrir. Essayer à nouveau.",
  'path.revealError': "Impossible d'afficher l'emplacement du fichier. Essayer à nouveau.",
  ...PRODUCT_NAMES,
  'app.finder': 'Finder',
  'app.explorer': 'Explorateur de fichiers',
  'app.filemanager': 'Fichiers',
  'app.terminal': 'Borne',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'open.title': 'In {app} öffnen',
  'path.appDefault': '{app} (Standard)',
  'path.appsError': 'Anwendungen konnten nicht geladen werden',
  'shortcut.busy': 'Arbeitsbereich öffnen',
  'shortcut.unavailable': 'Aktueller Arbeitsbereich oder lokale Anwendung nicht verfügbar',
  'open.tooltip': 'Vor Ort geöffnet',
  'path.open': 'Öffnen',
  'path.more': 'Mehr Möglichkeiten zum Öffnen',
  'path.reveal': 'Dateispeicherort anzeigen',
  'path.opened': 'Auf einem anderen Gerät geöffnet',
  'path.revealed': 'Dateispeicherort auf einem anderen Gerät angezeigt',
  'path.openError': 'Konnte nicht geöffnet werden. Versuchen Sie es erneut.',
  'path.revealError': 'Der Dateispeicherort konnte nicht angezeigt werden. Versuchen Sie es erneut.',
  ...PRODUCT_NAMES,
  'app.finder': 'Finder',
  'app.explorer': 'Datei-Explorer',
  'app.filemanager': 'Dateien',
  'app.terminal': 'Terminal',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'open.title': 'Открыть в {app}',
  'path.appDefault': '{app} (по умолчанию)',
  'path.appsError': 'Не удалось загрузить приложения',
  'shortcut.busy': 'Открытие рабочей области',
  'shortcut.unavailable': 'Текущая рабочая область или локальное приложение недоступно.',
  'open.tooltip': 'Открыть локально',
  'path.open': 'Открыть',
  'path.more': 'Больше способов открыть',
  'path.reveal': 'Показать местоположение файла',
  'path.opened': 'Открыто на другом устройстве',
  'path.revealed': 'Местоположение файла показано на другом устройстве',
  'path.openError': 'Не удалось открыть. Попробуйте еще раз.',
  'path.revealError': 'Не удалось показать местоположение файла. Попробуйте еще раз.',
  ...PRODUCT_NAMES,
  'app.finder': 'Finder',
  'app.explorer': 'Проводник файлов',
  'app.filemanager': 'Файлы',
  'app.terminal': 'Терминал',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'open.title': 'Abrir em {app}',
  'path.appDefault': '{app} (padrão)',
  'path.appsError': 'Não foi possível carregar aplicativos',
  'shortcut.busy': 'Abrindo espaço de trabalho',
  'shortcut.unavailable': 'Espaço de trabalho atual ou aplicativo local indisponível',
  'open.tooltip': 'Abrir localmente',
  'path.open': 'Abrir',
  'path.more': 'Mais maneiras de abrir',
  'path.reveal': 'Mostrar localização do arquivo',
  'path.opened': 'Aberto em outro dispositivo',
  'path.revealed': 'Localização do arquivo exibida em outro dispositivo',
  'path.openError': 'Não foi possível abrir. Tente novamente.',
  'path.revealError': 'Não foi possível mostrar o local do arquivo. Tente novamente.',
  ...PRODUCT_NAMES,
  'app.finder': 'Finder',
  'app.explorer': 'Explorador de arquivos',
  'app.filemanager': 'Arquivos',
  'app.terminal': 'Terminais',
} satisfies Record<keyof typeof en, string>
