; Electron user data and updater downloads leave with the application; the Harness home is never touched.
!include FileFunc.nsh
Var UnTarget
Var UnHome

; The helper refuses unsafe roots, the installation and the Harness home, and never descends into reparse points;
; a locked file leaves residue and never fails the uninstall. customCheckAppRunning extracts window-frame.dll first.
Function un.RemoveData
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveData(w "$UnTarget", w "$INSTDIR", w "$UnHome") ?c'
FunctionEnd

Function un.CleanData
  ${If} ${isUpdated}
    Return
  ${EndIf}
  ; The installer runs an older uninstaller with /KEEP_APP_DATA when replacing it from another directory.
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/KEEP_APP_DATA" $R1
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  ; Only a DSH_HOME published as a Windows environment variable is visible here.
  ReadEnvStr $UnHome DSH_HOME
  ClearErrors
  StrCpy $UnTarget "$APPDATA\${PRODUCT_FILENAME}"
  Call un.RemoveData
  !ifdef APP_PACKAGE_NAME
    ; Electron derives user data from the package name; a scoped name nests it one directory deeper.
    StrCpy $UnTarget "$APPDATA\${APP_PACKAGE_NAME}"
    Call un.RemoveData
    System::Call '$PLUGINSDIR\window-frame.dll::UninstallRemoveEmptyParents(w "$UnTarget", w "$APPDATA") ?c'
  !endif
  StrCpy $UnTarget "$LOCALAPPDATA\${DSH_UPDATER_CACHE_NAME}"
  Call un.RemoveData
FunctionEnd

; Upgrade replacement retains integrations; KEEP_APP_DATA controls only user data.
!define /ifndef DSH_COMMAND_ENVIRONMENT_KEY "Environment"
!define /ifndef DSH_COMMAND_OWNER_KEY "Software\DeepSeekHarness\Command"
!define /ifndef DSH_PROTOCOL_KEY "Software\Classes\dsh"
Function un.CleanRegistration
  ${If} ${isUpdated}
    Return
  ${EndIf}
  InitPluginsDir
  File /oname=$PLUGINSDIR\command-path.ps1 "${__FILEDIR__}\..\scripts\command-path.ps1"
  File /oname=$PLUGINSDIR\uninstall-registration.ps1 "${__FILEDIR__}\..\scripts\uninstall-registration.ps1"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\uninstall-registration.ps1" -Directory "$INSTDIR" -ExecutableName "${APP_EXECUTABLE_FILENAME}" -EnvironmentKey "${DSH_COMMAND_ENVIRONMENT_KEY}" -OwnerKey "${DSH_COMMAND_OWNER_KEY}" -ProtocolKey "${DSH_PROTOCOL_KEY}"'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint $1
    MessageBox MB_OK|MB_ICONSTOP "$(INSTALLER_UNINSTALL_REGISTRATION)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd
