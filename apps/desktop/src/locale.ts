/** Typed English and Chinese copy owned by the Electron shell. */

export const en = {
  application: 'Application',
  startupFailed: 'DeepSeek Harness could not start',
  startupLoading: 'Starting DeepSeek Harness…',
  startupLoadingDescription: 'Your workspace will open when it is ready.',
  startupErrorDescription: 'Choose a recovery action below. Disabling third-party plugins retains their files.',
  startupReinstallAdvice: 'If application files are missing or damaged, close the application and reinstall it. Your tasks are stored separately.',
  startupConfigurationAdvice: 'Reset Desktop deletes all Desktop profile configuration and third-party plugins without a backup, then starts a fresh profile. Shared tasks and settings are retained.',
  restartApplication: 'Close and restart',
  resetConfiguration: 'Reset Desktop and retry',
  disableThirdPartyPlugins: 'Disable all third-party plugins and retry',
  pluginsMenu: 'Desktop Plugins…',
  pluginsMenuPackagedOnly: 'Desktop Plugins… (available in packaged applications)',
  checkUpdatesMenu: 'Check for Updates…',
  updateCheckFailedTitle: 'Update Check Failed',
  unknownError: 'Unknown error',
  updateCheckTitle: 'Check for Updates',
  updateCurrent: 'You already have the latest version.',
  updateTitle: 'DeepSeek Harness Update',
  updateAvailable: 'An update is available',
  updateDetail: 'DeepSeek Harness {version}\n\nThis release includes its matching dsh version. The application will restart after installation.',
  installAndRestart: 'Install and Restart',
  later: 'Later',
  updateFailedTitle: 'Update Failed',
  pluginManagerTitle: 'Desktop Plugins',
  pluginWindowTitle: 'DeepSeek Harness — Desktop Plugins',
  pluginManagerDescription: 'Plugins are installed only in the Desktop node_modules and are managed by the bundled pnpm.',
  refresh: 'Refresh',
  enable: 'Enable',
  disable: 'Disable',
  disabled: 'Disabled',
  retry: 'Retry startup',
  disableAll: 'Disable all plugins and retry',
  recoveryDescription: 'The backend could not start. Update or disable incompatible plugins, then retry. Installed plugins and configuration are retained.',
  changingActivation: 'Changing plugin activation…',
  npmPackage: 'npm package',
  install: 'Install',
  installed: 'Installed',
  noPlugins: 'No Desktop plugins are installed.',
  remove: 'Remove',
  update: 'Update',
  targetVersion: 'Enter the target version for {name}',
  removing: 'Removing {name}…',
  updating: 'Updating {name}…',
  installing: 'Installing {spec}…',
  operationComplete: 'Done. The Desktop backend has restarted.',
  refreshing: 'Refreshing…',
  refreshed: 'Plugin list refreshed.',
  loadingPlugins: 'Reading Desktop plugins…',
} as const

/** Every Desktop locale supplies the complete English key set. */
export type DesktopMessages = { readonly [Key in keyof typeof en]: string }

export const zh = {
  application: '应用',
  startupFailed: 'DeepSeek Harness 无法启动',
  startupLoading: '正在启动 DeepSeek Harness…',
  startupLoadingDescription: '准备就绪后将自动打开工作区。',
  startupErrorDescription: '请选择下方的恢复操作。禁用第三方插件会保留插件文件。',
  startupReinstallAdvice: '如果应用文件缺失或损坏，请关闭应用并重新安装。任务数据存储在独立位置。',
  startupConfigurationAdvice: '重置 Desktop 会删除桌面端的全部 profile 配置和第三方插件，不保留备份，然后重新初始化并启动。共享任务和设置会保留。',
  restartApplication: '关闭并重启',
  resetConfiguration: '重置 Desktop 并重试',
  disableThirdPartyPlugins: '禁用全部第三方插件并重试',
  pluginsMenu: '桌面插件…',
  pluginsMenuPackagedOnly: '桌面插件…（打包应用中可用）',
  checkUpdatesMenu: '检查更新…',
  updateCheckFailedTitle: '更新检查失败',
  unknownError: '未知错误',
  updateCheckTitle: '检查更新',
  updateCurrent: '当前已是最新版本。',
  updateTitle: 'DeepSeek Harness 更新',
  updateAvailable: '发现可用更新',
  updateDetail: 'DeepSeek Harness {version}\n\n新版本绑定匹配的 dsh，安装后将重新启动。',
  installAndRestart: '安装并重启',
  later: '稍后',
  updateFailedTitle: '更新失败',
  pluginManagerTitle: '桌面插件',
  pluginWindowTitle: 'DeepSeek Harness — 桌面插件',
  pluginManagerDescription: '插件只安装到桌面端自己的 node_modules，并由内置 pnpm 管理。',
  refresh: '刷新',
  enable: '启用',
  disable: '禁用',
  disabled: '已禁用',
  retry: '重试启动',
  disableAll: '禁用全部插件并重试',
  recoveryDescription: '后端无法启动。请更新或禁用不兼容插件，然后重试。已安装插件和配置会保留。',
  changingActivation: '正在更改插件启用状态…',
  npmPackage: 'npm 包',
  install: '安装',
  installed: '已安装',
  noPlugins: '还没有安装桌面插件。',
  remove: '移除',
  update: '更新',
  targetVersion: '输入 {name} 的目标版本',
  removing: '正在移除 {name}…',
  updating: '正在更新 {name}…',
  installing: '正在安装 {spec}…',
  operationComplete: '操作完成，桌面后端已重新启动。',
  refreshing: '正在刷新…',
  refreshed: '插件列表已刷新。',
  loadingPlugins: '正在读取桌面插件…',
} as const satisfies DesktopMessages

/** Locale payload exposed to the Desktop-owned renderer. */
export interface DesktopLocale {
  readonly id: 'en' | 'zh-CN'
  readonly messages: DesktopMessages
}

/** Resolve Electron's locale to one shipped Desktop dictionary. */
export function resolveDesktopLocale(locale: string): DesktopLocale {
  return locale.toLowerCase().startsWith('zh')
    ? { id: 'zh-CN', messages: zh }
    : { id: 'en', messages: en }
}

/** Replace named placeholders in one locale-owned message. */
export function formatDesktopMessage(
  message: string,
  values: Readonly<Record<string, string>>,
): string {
  return message.replaceAll(/\{([^{}]+)\}/gu, (placeholder, key: string) => values[key] ?? placeholder)
}
