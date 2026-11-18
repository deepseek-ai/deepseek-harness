/** The pinned builder template keeps its registration flow around staged directory replacement. */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { expect, it } from 'vitest'
import { directoryInstallerExits, directoryInstallSection, directoryInstallUtil, directoryUninstaller } from '../scripts/windows-directory-installer.mjs'

const require = createRequire(import.meta.url)
const section = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')),
  'templates/nsis/installSection.nsh'), 'utf8')

it('retains data without preserving obsolete registrations when uninstalling another directory', () => {
  const source = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/include/installUtil.nsh'), 'utf8')
  const adapted = directoryInstallUtil(source)
  expect(adapted).toContain('${if} $installationDir == $INSTDIR\n      StrCpy $0 "$0 --updated"\n    ${endif}')
  expect(adapted).toContain('"$uninstallerFileNameTemp" /S /KEEP_APP_DATA $0 _?=$installationDir')
  expect(adapted).toContain('"$uninstallerFileName" /S /KEEP_APP_DATA $0 _?=$installationDir')
  expect(directoryInstallUtil(source.replaceAll('\n', '\r\n'))).toBe(adapted)
  expect(() => directoryInstallUtil(source.replace('StrCpy $0 "$0 --updated"', ''))).toThrow('template changed')
  expect(() => directoryInstallUtil(source + source)).toThrow('template changed')
})

it('keeps data cleanup out of the upstream template while retaining application removal and registration cleanup', () => {
  const source = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/uninstaller.nsh'), 'utf8')
  const adapted = directoryUninstaller(source)
  expect(adapted).not.toContain('--delete-app-data')
  expect(adapted).toContain('Goto dshUninstallFinished')
  expect(adapted.indexOf('Goto dshUninstallFinished')).toBeLessThan(adapted.indexOf('WinShell::UninstAppUserModelId'))
  expect(adapted).toContain('Call un.FinishCleanup')
  expect(adapted).toContain('UninstallNote')
  expect(adapted).not.toContain('RMDir /r "$APPDATA')
  expect(adapted).toContain('!insertmacro customUnInstall')
  expect(adapted.indexOf('!insertmacro customUnInstall')).toBeLessThan(adapted.indexOf('DeleteRegKey SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}"'))
  expect(adapted).toContain('DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"')
  expect(adapted).toContain('DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY_2}"')
  expect(directoryUninstaller(source.replaceAll('\n', '\r\n'))).toBe(adapted)
  expect(adapted).toContain('RMDir /r "\\\\?\\$INSTDIR"')
  expect(adapted).toContain('Rename "\\\\?\\$INSTDIR$R0\\$R2" "\\\\?\\$PLUGINSDIR\\old-install$R0\\$R2"')
  expect(adapted).toContain('Rename "\\\\?\\$PLUGINSDIR\\old-install$R0\\$R2" "\\\\?\\$INSTDIR$R0\\$R2"')
  expect(adapted).not.toContain('"$INSTDIR$R0')
  expect(adapted).not.toContain('"$PLUGINSDIR\\old-install')
  expect(() => directoryUninstaller(source.replace('  # delete the installed files\n', ''))).toThrow('template changed')
  expect(() => directoryUninstaller(source.replace('  Var /GLOBAL isDeleteAppData\n', ''))).toThrow('template changed')
  expect(() => directoryUninstaller(source.replace('  DeleteRegKey SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}"', ''))).toThrow('template changed')
})

it.each(['allowOnlyOneInstallerInstance.nsh', 'installUtil.nsh'])('cleans staged files before %s exits', (helper) => {
  const source = readFileSync(join(dirname(require.resolve('app-builder-lib/package.json')), 'templates/nsis/include', helper), 'utf8')
  const exits = source.match(/^\s*Quit\s*$/gm) ?? []
  expect(exits.length).toBeGreaterThan(0)
  const adapted = directoryInstallerExits(source)
  expect(adapted.match(/Call dshCleanupDirectories/g)).toHaveLength(exits.length)
  expect(adapted).toContain('!ifndef BUILD_UNINSTALLER')
})

it('stages before stopping the application and promotes before registering the installation', () => {
  const result = directoryInstallSection(section)
  expect(result.indexOf('!insertmacro dshStageApplication')).toBeLessThan(result.indexOf('!insertmacro CHECK_APP_RUNNING'))
  expect(result.indexOf('Call dshPromoteDirectories')).toBeLessThan(result.indexOf('!insertmacro registryAddInstallInfo'))
  expect(result).toContain('!insertmacro addStartMenuLink $keepShortcuts')
  expect(result).toContain('!insertmacro addDesktopLink $keepShortcuts')
  expect(result).toContain('!insertmacro handleUninstallResult HKEY_CURRENT_USER')
  expect(result).not.toContain('!insertmacro installApplicationFiles')
  expect(result).not.toContain('File /oname=uninstallerIcon.ico')
})

it.each(['!include installer.nsh', '!insertmacro setLinkVars', '!insertmacro installApplicationFiles'])(
  'rejects a missing or duplicate upstream insertion point: %s', (point) => {
    expect(() => directoryInstallSection(section.replace(point, ''))).toThrow('Desktop NSIS template changed')
    expect(() => directoryInstallSection(`${section}\n${point}`)).toThrow('Desktop NSIS template changed')
  },
)
