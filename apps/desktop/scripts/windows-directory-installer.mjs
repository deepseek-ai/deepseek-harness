/** Adapt the pinned NSIS template to stage and rename complete application directories. */
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

const require = createRequire(import.meta.url)
const templates = join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis')
const patched = Symbol.for('@deepseek-ai/dsh-desktop/directory-installer')

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Desktop NSIS template changed: ${before}`)
  return source.replace(before, after)
}

/**
 * Preserve upstream registration and uninstall UI while replacing payload installation.
 * @param {string} source - Pinned electron-builder installSection.nsh contents.
 * @returns {string} Section with staging before shutdown and directory promotion before registration.
 */
export function directoryInstallSection(source) {
  let result = source.replaceAll('\r\n', '\n')
  result = replaceOnce(result, '!include installer.nsh', `!include installer.nsh
!macroundef extractUsing7za
!macro extractUsing7za FILE
  !insertmacro dshExtractPayload "\${FILE}"
!macroend
!macroundef uninstallOldVersion
!macro uninstallOldVersion ROOT_KEY
  !insertmacro readReg $R4 "\${ROOT_KEY}" "\${INSTALL_REGISTRY_KEY}" InstallLocation
  \${If} $R4 == $INSTDIR
    StrCpy $R0 0
    ClearErrors
  \${Else}
    Push "\${ROOT_KEY}"
    Call uninstallOldVersion
  \${EndIf}
!macroend`)
  result = replaceOnce(result, '!insertmacro setLinkVars', `!insertmacro setLinkVars
!insertmacro dshStageApplication`)
  result = replaceOnce(result, '!insertmacro installApplicationFiles', 'Call dshPromoteDirectories\nIfErrors 0 +4\n  SetErrorLevel 2\n  MessageBox MB_OK|MB_ICONEXCLAMATION "$(appCannotBeClosed)" /SD IDOK\n  Quit')
  result = replaceOnce(result, '!ifdef UNINSTALLER_ICON\n  File /oname=uninstallerIcon.ico "${UNINSTALLER_ICON}"\n!endif\n', '')
  // The staging macro uses the upstream installer macro, including its signed uninstaller.
  return result
}

/**
 * Clean staged directories on upstream Quit paths, including silent installers.
 * @param {string} source - Pinned NSIS helper source.
 * @returns {string} Helper with cleanup before installer exits.
 */
export function directoryInstallerExits(source) {
  return source.replaceAll(/^(\s*)Quit\s*$/gm, '$1!ifndef BUILD_UNINSTALLER\n$1Call dshCleanupDirectories\n$1!endif\n$1Quit')
}

/** Install the build-only NSIS adapter without replacing electron-builder's signed bootstrap path. */
export function installWindowsDirectoryInstaller() {
  // The package entry initializes the platform classes before their mutually dependent leaves.
  require('app-builder-lib')
  const { NsisTarget } = require('app-builder-lib/out/targets/nsis/NsisTarget.js')
  const { getPath7za } = require('app-builder-lib/out/toolsets/7zip.js')
  const prototype = NsisTarget.prototype
  if (prototype[patched]) return
  prototype[patched] = true
  const compute = prototype.computeFinalScript
  prototype.computeFinalScript = async function (source, ...args) {
    const directory = join(this.outDir, '.nsis-directory-installer')
    await mkdir(directory, { recursive: true })
    const section = join(directory, 'installSection.nsh')
    await writeFile(section, directoryInstallSection(await readFile(join(templates, 'installSection.nsh'), 'utf8')))
    const sourceTool = await getPath7za()
    const tool = join(directory, '7za.exe')
    await copyFile(sourceTool, tool)
    await this.packager.signIf(tool)
    let adapted = replaceOnce(source, '!include "installSection.nsh"', `!include "${section}"`)
    for (const helper of ['allowOnlyOneInstallerInstance.nsh', 'installUtil.nsh']) {
      const path = join(directory, helper)
      await writeFile(path, directoryInstallerExits(await readFile(join(templates, 'include', helper), 'utf8')))
      adapted = replaceOnce(adapted, `!include "${helper}"`, `!include "${path}"`)
    }
    const uninstaller = join(directory, 'uninstaller.nsh')
    await writeFile(uninstaller, directoryUninstaller(await readFile(join(templates, 'uninstaller.nsh'), 'utf8')))
    adapted = replaceOnce(adapted, '!include "uninstaller.nsh"', `!include "${uninstaller}"`)
    return `!define DSH_UPDATER_CACHE_NAME "${this.packager.appInfo.updaterCacheDirName}"\n!define DSH_SEVENZIP_PATH "${tool}"\n!define DSH_SEVENZIP_LICENSE_DIR "${dirname(dirname(sourceTool))}"\n${await compute.call(this, adapted, ...args)}`
  }
}

/**
 * Keep user-data removal in the native helper, which refuses unsafe roots and never follows links.
 * @param {string} source - Pinned upstream uninstaller source.
 * @returns {string} Uninstaller with long-path application removal and no upstream RMDir data removal.
 */
export function directoryUninstaller(source) {
  const normalized = source.replaceAll('\r\n', '\n')
  const start = normalized.indexOf('  Var /GLOBAL isDeleteAppData\n')
  const end = normalized.indexOf('  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"', start)
  if (start < 0 || end < 0) throw new Error('NSIS uninstaller data removal template changed')
  return replaceOnce(normalized.slice(0, start) + normalized.slice(end), 'RMDir /r $INSTDIR', 'RMDir /r "\\\\?\\$INSTDIR"')
}
