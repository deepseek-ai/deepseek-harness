/**
 * Browser half of the browse directory-picker backend: fills ui-workspace's
 * two directory-flow holes with the in-app Select Workspace Directory dialog
 * (figma `Harness` 813-23126 family), driving the node half's
 * `directoryPicker/list`/`directoryPicker/createDirectory` primitives.
 * Mounting this package therefore composes both sides of the browse
 * interaction with one cordis.yml row; no client code branches on a
 * capability kind. The dialog's copy is locale-registered here — the flow
 * package owns its own strings.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the SlotMap merge declaring the directory-flow holes.
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { BrowseFlowInjected } from './flow.ts'
import { BrowseDirectoryFlow } from './flow.ts'

/** Locale namespace owning the browser dialog's copy. */
const LOCALE_NS = 'directory-browser'

/** Required services (cordis fiber inject): the slot registry, workspace UI service, and locale. */
export const inject = ['slots', 'uiWorkspace', 'locale']

/**
 * Client plugin body: register the dialog's dictionaries and the browse flow
 * into both directory-flow holes through `slots.inject()` because the
 * ui-workspace entries may activate later or replace their declarations.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => {
    // The dictionaries land as a unit: if the second registration hits a
    // rival owner of the namespace, the first rolls back before the throw —
    // a failed activation must not squat the namespace's other locale.
    const disposers: (() => void)[] = []
    const dictionaries: [locale: string, dict: Record<string, string>][] = [
      ['zh', {
        'browser.title': '选择工作区目录',
        'browser.home': '主目录',
        'browser.newFolder': '新建文件夹',
        'browser.folderName': '文件夹名称',
        'browser.createIn': '在"{name}"中新建文件夹',
        'browser.untitledFolder': '未命名文件夹',
        'browser.create': '创建',
        'browser.cancel': '取消',
        'browser.open': '打开',
        'browser.editPath': '编辑路径',
        'browser.loading': '加载中…',
        'browser.truncated': '文件夹过多，仅显示开头部分。',
        'browser.showHidden': '显示隐藏文件',
      }],
      ['en', {
        'browser.title': 'Select Workspace Directory',
        'browser.home': 'Home',
        'browser.newFolder': 'New folder',
        'browser.folderName': 'Folder name',
        'browser.createIn': 'New folder in "{name}"',
        'browser.untitledFolder': 'Untitled folder',
        'browser.create': 'Create',
        'browser.cancel': 'Cancel',
        'browser.open': 'Open',
        'browser.editPath': 'Edit path',
        'browser.loading': 'Loading…',
        'browser.truncated': 'Too many folders to list; only the beginning is shown.',
        'browser.showHidden': 'Show hidden files',
      }],
      ['ja', {
        'browser.title': 'ワークスペースディレクトリを選択',
        'browser.home': 'ホーム',
        'browser.newFolder': '新しいフォルダ',
        'browser.folderName': 'フォルダ名',
        'browser.createIn': '「{name}」内に新しいフォルダ',
        'browser.untitledFolder': '名称未設定フォルダ',
        'browser.create': '作成',
        'browser.cancel': 'キャンセル',
        'browser.open': '開く',
        'browser.editPath': 'パスを編集',
        'browser.loading': '読み込み中…',
        'browser.truncated': 'フォルダが多すぎて一覧表示できません。先頭のみ表示しています。',
        'browser.showHidden': '隠しファイルを表示',
      }],
      ['es', {
        'browser.title': 'Seleccionar carpeta de trabajo',
        'browser.home': 'Inicio',
        'browser.newFolder': 'Nueva carpeta',
        'browser.folderName': 'Nombre de la carpeta',
        'browser.createIn': 'Nueva carpeta en "{name}"',
        'browser.untitledFolder': 'Carpeta sin título',
        'browser.create': 'Crear',
        'browser.cancel': 'Cancelar',
        'browser.open': 'Abrir',
        'browser.editPath': 'Editar ruta',
        'browser.loading': 'Cargando…',
        'browser.truncated': 'Hay demasiadas carpetas; solo se muestra el principio.',
        'browser.showHidden': 'Mostrar archivos ocultos',
      }],
      ['fr', {
        'browser.title': 'Choisir le dossier de travail',
        'browser.home': 'Dossier personnel',
        'browser.newFolder': 'Nouveau dossier',
        'browser.folderName': 'Nom du dossier',
        'browser.createIn': 'Nouveau dossier dans « {name} »',
        'browser.untitledFolder': 'Dossier sans titre',
        'browser.create': 'Créer',
        'browser.cancel': 'Annuler',
        'browser.open': 'Ouvrir',
        'browser.editPath': 'Modifier le chemin',
        'browser.loading': 'Chargement…',
        'browser.truncated': 'Trop de dossiers à afficher ; seul le début est affiché.',
        'browser.showHidden': 'Afficher les fichiers cachés',
      }],
      ['de', {
        'browser.title': 'Arbeitsverzeichnis auswählen',
        'browser.home': 'Persönlicher Ordner',
        'browser.newFolder': 'Neuer Ordner',
        'browser.folderName': 'Ordnername',
        'browser.createIn': 'Neuer Ordner in „{name}“',
        'browser.untitledFolder': 'Unbenannter Ordner',
        'browser.create': 'Erstellen',
        'browser.cancel': 'Abbrechen',
        'browser.open': 'Öffnen',
        'browser.editPath': 'Pfad bearbeiten',
        'browser.loading': 'Laden…',
        'browser.truncated': 'Zu viele Ordner; nur der Anfang wird angezeigt.',
        'browser.showHidden': 'Versteckte Dateien anzeigen',
      }],
      ['ru', {
        'browser.title': 'Выбрать рабочую папку',
        'browser.home': 'Домашняя папка',
        'browser.newFolder': 'Новая папка',
        'browser.folderName': 'Имя папки',
        'browser.createIn': 'Новая папка в «{name}»',
        'browser.untitledFolder': 'Папка без названия',
        'browser.create': 'Создать',
        'browser.cancel': 'Отмена',
        'browser.open': 'Открыть',
        'browser.editPath': 'Изменить путь',
        'browser.loading': 'Загрузка…',
        'browser.truncated': 'Папок слишком много; показана только начальная часть списка.',
        'browser.showHidden': 'Показать скрытые файлы',
      }],
      ['pt', {
        'browser.title': 'Selecionar pasta de trabalho',
        'browser.home': 'Pasta pessoal',
        'browser.newFolder': 'Nova pasta',
        'browser.folderName': 'Nome da pasta',
        'browser.createIn': 'Nova pasta em "{name}"',
        'browser.untitledFolder': 'Pasta sem nome',
        'browser.create': 'Criar',
        'browser.cancel': 'Cancelar',
        'browser.open': 'Abrir',
        'browser.editPath': 'Editar caminho',
        'browser.loading': 'Carregando…',
        'browser.truncated': 'Há pastas demais; apenas o início é exibido.',
        'browser.showHidden': 'Mostrar arquivos ocultos',
      }],
    ]
    try {
      for (const [locale, dict] of dictionaries) disposers.push(ctx.locale.register(LOCALE_NS, locale, dict))
    } catch (error) {
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => { for (const dispose of disposers) dispose() }
  }, 'directory-picker-browse: dialog dictionaries')

  const injected = (): BrowseFlowInjected => ({
    listDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal),
    createDirectory: (path, name) => ctx.uiWorkspace.createDirectory(path, name),
    t: ctx.locale.bind(LOCALE_NS),
  })
  // Both declaration lifetimes must be live before the pair installs; the
  // generator makes the two registrations one transactional effect. The
  // outer/inner nesting order is arbitrary; neither hole has precedence.
  ctx.slots.inject('conversation.hero.workspace.directoryFlow', () =>
    ctx.slots.inject('sidebar.workspaces.directoryFlow', function* () {
      yield ctx.slots.register({
        name: 'conversation.hero.workspace.directoryFlow', inject: injected,
      }, BrowseDirectoryFlow)
      yield ctx.slots.register({
        name: 'sidebar.workspaces.directoryFlow', inject: injected,
      }, BrowseDirectoryFlow)
    }))
}
