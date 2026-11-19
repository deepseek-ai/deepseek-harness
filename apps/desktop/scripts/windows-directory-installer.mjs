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
  result = replaceOnce(result, '!insertmacro installApplicationFiles', 'Call dshPromoteDirectories\nIfErrors 0 +3\n  SetErrorLevel 2\n  Quit')
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

/**
 * Preserve data but clean old registrations when replacing another installation directory.
 * @param {string} source - Pinned NSIS installUtil.nsh contents.
 * @returns {string} Helper reserving --updated for replacement at the same path.
 */
export function directoryInstallUtil(source) {
  return replaceOnce(source.replaceAll('\r\n', '\n'),
    '    # always pass --updated flag - to ensure that if DELETE_APP_DATA_ON_UNINSTALL is defined, user data will be not removed\n    StrCpy $0 "$0 --updated"',
    '    # /KEEP_APP_DATA retains data during relocation; old path registrations must be removed.\n    ${if} $installationDir == $INSTDIR\n      StrCpy $0 "$0 --updated"\n    ${endif}')
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
      const original = await readFile(join(templates, 'include', helper), 'utf8')
      await writeFile(path, directoryInstallerExits(helper === 'installUtil.nsh' ? directoryInstallUtil(original) : original))
      adapted = replaceOnce(adapted, `!include "${helper}"`, `!include "${path}"`)
    }
    const uninstaller = join(directory, 'uninstaller.nsh')
    await writeFile(uninstaller, directoryUninstaller(await readFile(join(templates, 'uninstaller.nsh'), 'utf8')))
    adapted = replaceOnce(adapted, '!include "uninstaller.nsh"', `!include "${uninstaller}"`)
    return `!define DSH_UPDATER_CACHE_NAME "${this.packager.appInfo.updaterCacheDirName}"\n!define DSH_SEVENZIP_PATH "${tool}"\n!define DSH_SEVENZIP_LICENSE_DIR "${dirname(dirname(sourceTool))}"\n${await compute.call(this, adapted, ...args)}`
  }
}

/**
 * Retain the original uninstall directory and bypass shared cleanup for directory-only removal.
 * @param {string} source - Pinned upstream uninstaller source.
 * @returns {string} Uninstaller with long-path removal, native data cleanup, and upgrade rollback; updated-mode ownership mismatches exit with code 2.
 */
export function directoryUninstaller(source) {
  let normalized = source.replaceAll('\r\n', '\n')
  normalized = normalized.replaceAll('"$INSTDIR$R0', '"\\\\?\\$INSTDIR$R0')
    .replaceAll('"$PLUGINSDIR\\old-install', '"\\\\?\\$PLUGINSDIR\\old-install')
  normalized = replaceOnce(normalized, 'Function un.onInit\n', 'Var dshUninstallDirectory\nFunction un.onInit\n  StrCpy $dshUninstallDirectory $INSTDIR\n')
  normalized = replaceOnce(normalized, '  !insertmacro initMultiUser', `  !insertmacro initMultiUser
  StrCpy $INSTDIR $dshUninstallDirectory
  \${If} \${isUpdated}
    ReadRegStr $R0 SHELL_CONTEXT "\${INSTALL_REGISTRY_KEY}" InstallLocation
    GetFullPathName $R0 "$R0\\."
    GetFullPathName $R1 "$INSTDIR\\."
    \${If} $R0 != $R1
      SetErrorLevel 2
      Quit
    \${EndIf}
  \${EndIf}`)
  const payloadStart = normalized.indexOf('  # delete the installed files\n')
  const payloadEnd = normalized.indexOf('  ${ifNot} ${isKeepShortcuts}', payloadStart)
  if (payloadStart < 0 || payloadEnd < 0) throw new Error('NSIS uninstaller payload template changed')
  normalized = normalized.slice(0, payloadStart) + '  ${If} ${isUpdated}\n'
    + normalized.slice(payloadStart, payloadEnd) + '  ${EndIf}\n'
    + '  ${If} $UnDirectoryOnly == 1\n    Goto dshUninstallFinished\n  ${EndIf}\n'
    + normalized.slice(payloadEnd)
  normalized = replaceOnce(normalized, '  !ifdef ONE_CLICK\n    !insertmacro quitSuccess',
    'dshUninstallFinished:\n  Call un.FinishCleanup\n  !ifdef ONE_CLICK\n    !insertmacro quitSuccess')
  const start = normalized.indexOf('  Var /GLOBAL isDeleteAppData\n')
  const end = normalized.indexOf('  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"', start)
  if (start < 0 || end < 0) throw new Error('NSIS uninstaller data removal template changed')
  normalized = normalized.slice(0, start) + normalized.slice(end)
  normalized = normalized.replaceAll(/^(\s*)(DeleteRegKey SHELL_CONTEXT "[^"]+"|Delete "\$old(?:Desktop|StartMenu)Link")$/gm, (_, indent, operation) =>
    `${indent}ClearErrors\n${indent}${operation}\n${indent}\${If} \${Errors}\n${indent}  \${IfNot} \${isUpdated}\n${indent}    System::Call '$PLUGINSDIR\\window-frame.dll::UninstallNote(p $UnSession, w "[unverified] ${operation.replaceAll('"', '')}") ?c'\n${indent}  \${EndIf}\n${indent}\${EndIf}`)
  return replaceOnce(normalized, 'RMDir /r $INSTDIR', 'RMDir /r "\\\\?\\$INSTDIR"')
}
