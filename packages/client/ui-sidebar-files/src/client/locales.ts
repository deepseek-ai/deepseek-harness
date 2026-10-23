/**
 * `sidebarFiles` namespace dictionaries, and the namespace's declaration.
 *
 * The failure lines name what the tree could not list, one code each, because a
 * directory that is gone, one outside the workspace, and a path that is not a
 * directory each suggest a different next step.
 *
 * The namespace merge lives with its key set so that any module naming
 * `TranslateNS<'sidebarFiles'>` or `PropsLocale<'sidebarFiles'>` needs only this
 * file, whichever entry a program loads first.
 */
import type {} from '@deepseek-ai/dsh-client-ui-slots'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** File-tree type name, guide entry, row states, and failure lines. */
    sidebarFiles: SidebarFilesKey
  }
}

/** Simplified Chinese dictionary and key-set source of truth. */
export const zh = {
  'shortcut.noSession': '请先选择会话',
  'type.label': '文件',
  'guide.title': '工作区文件',
  'guide.description': '浏览会话工作区的文件',
  loading: '正在读取…',
  empty: '空目录',
  truncated: '条目太多，只显示了一部分。',
  noWorkspace: '这个会话没有工作区目录。',
  reload: '重新读取',
  autoRefresh: '自动刷新',
  'autoRefresh.enable': '开启自动刷新',
  'autoRefresh.disable': '关闭自动刷新',
  'entry.other': '这不是文件或目录，没法打开。',
  'error.notFound': '这个目录不在了。可能已被移动或删除。',
  'error.outsideWorkspace': '这个目录在工作区之外，侧栏不会读取它。',
  'error.notDirectory': '这不是一个目录。',
  'error.unavailable': '读取失败：{message}',
} satisfies Record<string, string>

/** Files dictionary key union. */
export type SidebarFilesKey = keyof typeof zh

/** English dictionary, checked against the Chinese key set. */
export const en = {
  'shortcut.noSession': 'Select a session first',
  'type.label': 'Files',
  'guide.title': 'Workspace files',
  'guide.description': 'Browse files in this session\'s workspace',
  loading: 'Reading…',
  empty: 'Empty directory',
  truncated: 'Too many entries, showing only some of them.',
  noWorkspace: 'This session has no workspace directory.',
  reload: 'Reload',
  autoRefresh: 'Auto refresh',
  'autoRefresh.enable': 'Enable auto refresh',
  'autoRefresh.disable': 'Disable auto refresh',
  'entry.other': 'Not a file or a directory, so it cannot be opened.',
  'error.notFound': 'That directory is gone. It may have been moved or deleted.',
  'error.outsideWorkspace': 'That directory is outside the workspace, so the sidebar will not read it.',
  'error.notDirectory': 'That is not a directory.',
  'error.unavailable': 'Read failed: {message}',
} satisfies Record<SidebarFilesKey, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'shortcut.noSession': '先にセッションを選択してください',
  'type.label': 'ファイル',
  'guide.title': 'ワークスペースのファイル',
  'guide.description': 'このセッションのワークスペース内のファイルを参照',
  'loading': '読み取り中…',
  'empty': '空のディレクトリ',
  'truncated': 'エントリが多すぎるため、一部のみ表示しています。',
  'noWorkspace': 'このセッションにはワークスペースディレクトリがありません。',
  'reload': '再読み込み',
  'autoRefresh': '自動更新',
  'autoRefresh.enable': '自動更新を有効にする',
  'autoRefresh.disable': '自動更新を無効にする',
  'entry.other': 'ファイルでもディレクトリでもないため、開けません。',
  'error.notFound': 'そのディレクトリは存在しません。移動または削除された可能性があります。',
  'error.outsideWorkspace': 'そのディレクトリはワークスペース外のため、サイドバーでは読み取りません。',
  'error.notDirectory': 'それはディレクトリではありません。',
  'error.unavailable': '読み取りに失敗しました: {message}',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'shortcut.noSession': 'Seleccione una sesión primero',
  'type.label': 'Archivos',
  'guide.title': 'Archivos de espacio de trabajo',
  'guide.description': 'Explorar archivos en el espacio de trabajo de esta sesión',
  loading: 'Leyendo…',
  empty: 'directorio vacio',
  truncated: 'Demasiadas entradas y solo se muestran algunas de ellas.',
  noWorkspace: 'Esta sesión no tiene ningún directorio de espacio de trabajo.',
  reload: 'recargar',
  autoRefresh: 'Actualización automática',
  'autoRefresh.enable': 'Habilitar actualización automática',
  'autoRefresh.disable': 'Deshabilitar la actualización automática',
  'entry.other': 'No es un archivo ni un directorio, por lo que no se puede abrir.',
  'error.notFound': 'Ese directorio desapareció. Es posible que se haya movido o eliminado.',
  'error.outsideWorkspace': 'Ese directorio está fuera del espacio de trabajo, por lo que la barra lateral no lo leerá.',
  'error.notDirectory': 'Eso no es un directorio.',
  'error.unavailable': 'Error de lectura: {message}',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'shortcut.noSession': "Sélectionnez d'abord une session",
  'type.label': 'Fichiers',
  'guide.title': "Fichiers de l'espace de travail",
  'guide.description': "Parcourir les fichiers dans l'espace de travail de cette session",
  loading: 'Lecture…',
  empty: 'Répertoire vide',
  truncated: "Trop d'entrées, n'en affichant que certaines.",
  noWorkspace: "Cette session n'a pas de répertoire d'espace de travail.",
  reload: 'Recharger',
  autoRefresh: 'Actualisation automatique',
  'autoRefresh.enable': "Activer l'actualisation automatique",
  'autoRefresh.disable': "Désactiver l'actualisation automatique",
  'entry.other': "Il ne s'agit pas d'un fichier ou d'un répertoire, il ne peut donc pas être ouvert.",
  'error.notFound': 'Ce répertoire a disparu. Il a peut-être été déplacé ou supprimé.',
  'error.outsideWorkspace': 'Ce répertoire se trouve en dehors de l’espace de travail, donc la barre latérale ne le lira pas.',
  'error.notDirectory': "Ce n'est pas un répertoire.",
  'error.unavailable': 'Échec de lecture : {message}',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'shortcut.noSession': 'Wählen Sie zunächst eine Sitzung aus',
  'type.label': 'Dateien',
  'guide.title': 'Arbeitsbereichsdateien',
  'guide.description': 'Durchsuchen Sie die Dateien im Arbeitsbereich dieser Sitzung',
  loading: 'Lesen…',
  empty: 'Leeres Verzeichnis',
  truncated: 'Zu viele Einträge, es werden nur einige davon angezeigt.',
  noWorkspace: 'Diese Sitzung hat kein Arbeitsbereichsverzeichnis.',
  reload: 'Neu laden',
  autoRefresh: 'Automatische Aktualisierung',
  'autoRefresh.enable': 'Aktivieren Sie die automatische Aktualisierung',
  'autoRefresh.disable': 'Deaktivieren Sie die automatische Aktualisierung',
  'entry.other': 'Keine Datei oder kein Verzeichnis, daher kann sie nicht geöffnet werden.',
  'error.notFound': 'Dieses Verzeichnis ist weg. Möglicherweise wurde es verschoben oder gelöscht.',
  'error.outsideWorkspace': 'Dieses Verzeichnis liegt außerhalb des Arbeitsbereichs und wird daher von der Seitenleiste nicht gelesen.',
  'error.notDirectory': 'Das ist kein Verzeichnis.',
  'error.unavailable': 'Lesen fehlgeschlagen: {message}',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'shortcut.noSession': 'Сначала выберите сеанс',
  'type.label': 'Файлы',
  'guide.title': 'Файлы рабочей области',
  'guide.description': 'Просмотр файлов в рабочей области этого сеанса',
  loading: 'Чтение…',
  empty: 'Пустой каталог',
  truncated: 'Слишком много записей, показаны только некоторые из них.',
  noWorkspace: 'В этом сеансе нет каталога рабочей области.',
  reload: 'Перезагрузить',
  autoRefresh: 'Автоматическое обновление',
  'autoRefresh.enable': 'Включить автоматическое обновление',
  'autoRefresh.disable': 'Отключить автоматическое обновление',
  'entry.other': 'Это не файл и не каталог, поэтому его нельзя открыть.',
  'error.notFound': 'Этот каталог исчез. Возможно, оно было перемещено или удалено.',
  'error.outsideWorkspace': 'Этот каталог находится за пределами рабочей области, поэтому боковая панель его не читает.',
  'error.notDirectory': 'Это не каталог.',
  'error.unavailable': 'Не удалось прочитать: {message}.',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'shortcut.noSession': 'Selecione uma sessão primeiro',
  'type.label': 'Arquivos',
  'guide.title': 'Arquivos do espaço de trabalho',
  'guide.description': 'Procure arquivos no espaço de trabalho desta sessão',
  loading: 'Lendo…',
  empty: 'Diretório vazio',
  truncated: 'Muitas entradas, mostrando apenas algumas delas.',
  noWorkspace: 'Esta sessão não possui diretório de espaço de trabalho.',
  reload: 'Recarregar',
  autoRefresh: 'Atualização automática',
  'autoRefresh.enable': 'Ativar atualização automática',
  'autoRefresh.disable': 'Desativar atualização automática',
  'entry.other': 'Não é um arquivo ou diretório, portanto não pode ser aberto.',
  'error.notFound': 'Esse diretório desapareceu. Pode ter sido movido ou excluído.',
  'error.outsideWorkspace': 'Esse diretório está fora da área de trabalho, portanto a barra lateral não o lerá.',
  'error.notDirectory': 'Isso não é um diretório.',
  'error.unavailable': 'Falha na leitura: {message}',
} satisfies Record<keyof typeof en, string>
