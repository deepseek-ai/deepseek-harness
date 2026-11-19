; Electron user data and updater downloads leave with the application; the Harness home is never touched.
!include FileFunc.nsh
Var UnTarget
Var UnHome
Var UnSession
Var UnDirectoryOnly
Var UnReportPath
Var UnHeading
Var UnBody
Var UnMode
Var UnResult
Var UnRegistered
Var UnRegistrationArguments
Var UnRegistrationEligible
Var UnCleanupResult

Function un.ShowCleanup
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallPersist(p $UnSession) ?c'
  StrCpy $UnResult 0
  ${IfNot} ${Silent}
    ${If} $UnMode == 1
      System::Call '$PLUGINSDIR\window-frame.dll::UninstallShowOwner(p $UnSession, p $HWNDPARENT, w "$(^SetupCaption)", w "$UnHeading", w "$UnRegistered", w "$INSTDIR", w "$(INSTALLER_UNINSTALL_REGISTERED)", w "$(INSTALLER_UNINSTALL_SCOPE)", w "$(INSTALLER_UNINSTALL_CONTINUE)", w "$(INSTALLER_UNINSTALL_SAVE)", w "$(INSTALLER_UNINSTALL_SAVE_FAILED)") i.r0 ?c'
    ${Else}
    System::Call '$PLUGINSDIR\window-frame.dll::UninstallShow(p $UnSession, p $HWNDPARENT, i $UnMode, w "$(^SetupCaption)", w "$UnHeading", w "$UnBody", w "$(INSTALLER_UNINSTALL_CONTINUE)", w "$(INSTALLER_UNINSTALL_SAVE)", w "$(INSTALLER_UNINSTALL_SAVE_FAILED)") i.r0 ?c'
    ${EndIf}
    StrCpy $UnResult $0
  ${EndIf}
FunctionEnd

Function un.BeginCleanup
  ${If} ${isUpdated}
    Return
  ${EndIf}
  InitPluginsDir
  File "/oname=$PLUGINSDIR\window-frame.dll" "${INSTALLER_BUILD_DIR}\window-frame.dll"
  System::Call 'kernel32::GetCurrentProcessId() i.r0'
  StrCpy $UnReportPath "$TEMP\DeepSeek-Harness-uninstall-$0.txt"
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallBegin(w "$UnReportPath") p.r0 ?c'
  StrCpy $UnSession $0
  ${If} $UnSession == 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_UI_ERROR)" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  ReadEnvStr $UnHome DSH_HOME
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallPrepare(p $UnSession, w "$INSTDIR", w "$UnHome") i.r0 ?c'
  ${If} $0 != 0
    StrCpy $UnMode 4
    StrCpy $UnHeading "$(INSTALLER_UNINSTALL_INCOMPLETE)"
    StrCpy $UnBody "$(INSTALLER_UNINSTALL_UNSAFE)$\r$\n$INSTDIR"
    Call un.ShowCleanup
    SetErrorLevel 2
    Quit
  ${EndIf}
  ReadRegStr $UnRegistered SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $UnRegistered != ""
    GetFullPathName $UnRegistered "$UnRegistered\."
    GetFullPathName $0 "$INSTDIR\."
    ${If} $UnRegistered != $0
      StrCpy $UnMode 1
      StrCpy $UnHeading "$(INSTALLER_UNINSTALL_OWNER)"
      Call un.ShowCleanup
      ${If} $UnResult != 1001
        System::Call '$PLUGINSDIR\window-frame.dll::UninstallNote(p $UnSession, w "Removal not confirmed; no deletion started. Registered installation: $UnRegistered. Uninstall directory: $INSTDIR.") ?c'
        System::Call '$PLUGINSDIR\window-frame.dll::UninstallPersist(p $UnSession) ?c'
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $UnDirectoryOnly 1
    ${EndIf}
  ${EndIf}
  SetOutPath $TEMP
  cleanupRetry:
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallPayload(p $UnSession, w "$INSTDIR", w "${APP_EXECUTABLE_FILENAME}", w "${UNINSTALL_FILENAME}") i.r0 ?c'
  ${If} $0 != 0
    StrCpy $UnMode 4
    StrCpy $UnHeading "$(INSTALLER_UNINSTALL_INCOMPLETE)"
    StrCpy $UnBody "$(INSTALLER_UNINSTALL_UNKNOWN)$\r$\n$INSTDIR"
    ${If} $0 == 1
      StrCpy $UnMode 2
      StrCpy $UnBody "$(INSTALLER_UNINSTALL_BLOCKED)$\r$\n$INSTDIR\${APP_EXECUTABLE_FILENAME}"
    ${EndIf}
    Call un.ShowCleanup
    ${If} $UnResult == 4
      Goto cleanupRetry
    ${EndIf}
    SetErrorLevel 2
    Quit
  ${EndIf}
FunctionEnd

Function un.FinishCleanup
  ${If} ${isUpdated}
    Return
  ${EndIf}
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallFinish(p $UnSession, w "$INSTDIR", w "${UNINSTALL_FILENAME}") i.r0 ?c'
  StrCpy $UnCleanupResult $0
  ${If} $UnRegistrationEligible == 1
    StrCpy $UnRegistrationArguments "-UnownedOnly"
    Call un.RunRegistrationCleanup
  ${EndIf}
  ${If} $UnCleanupResult != 0
    DetailPrint $UnReportPath
    StrCpy $UnMode 3
    StrCpy $UnHeading "$(INSTALLER_UNINSTALL_COMPLETE)"
    StrCpy $UnBody "$(INSTALLER_UNINSTALL_REGISTRATION)"
    Call un.ShowCleanup
  ${EndIf}
FunctionEnd

; The helper refuses unsafe roots, the installation and the Harness home, and never descends into reparse points;
; failed auxiliary removals are recorded while other siblings continue.
Function un.RemoveData
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallData(p $UnSession, w "$UnTarget", w "$INSTDIR", w "$UnHome") ?c'
FunctionEnd

Function un.CleanData
  ${If} ${isUpdated}
  ${OrIf} $UnDirectoryOnly == 1
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
!define /ifndef DSH_COMMAND_MUTEX "default"
Function un.CleanRegistration
  ${If} ${isUpdated}
    Return
  ${EndIf}
  ReadRegStr $0 SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" InstallLocation
  ${If} $0 == ""
    ; Preserve shared state and check each Windows entry against its own target.
    StrCpy $UnDirectoryOnly 1
  ${Else}
    GetFullPathName $0 "$0\."
    GetFullPathName $1 "$INSTDIR\."
    ${If} $0 != $1
      StrCpy $UnDirectoryOnly 1
    ${EndIf}
  ${EndIf}
  Delete "$PLUGINSDIR\unowned-path"
  StrCpy $UnRegistrationArguments ""
  ${If} $UnDirectoryOnly == 1
    StrCpy $UnRegistrationArguments '-DesktopLink "$oldDesktopLink" -StartMenuLink "$oldStartMenuLink" -UninstallKey "${UNINSTALL_REGISTRY_KEY}" -UninstallerName "${UNINSTALL_FILENAME}"'
    !ifdef UNINSTALL_REGISTRY_KEY_2
      StrCpy $UnRegistrationArguments '$UnRegistrationArguments -LegacyUninstallKey "${UNINSTALL_REGISTRY_KEY_2}"'
    !endif
  ${EndIf}
  Call un.RunRegistrationCleanup
  IfFileExists "$PLUGINSDIR\unowned-path" 0 +2
    StrCpy $UnRegistrationEligible 1
FunctionEnd

Function un.RunRegistrationCleanup
  InitPluginsDir
  File /oname=$PLUGINSDIR\command-path.ps1 "${__FILEDIR__}\..\scripts\command-path.ps1"
  File /oname=$PLUGINSDIR\uninstall-registration.ps1 "${__FILEDIR__}\..\scripts\uninstall-registration.ps1"
  Delete "$PLUGINSDIR\registration-report.txt"
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\uninstall-registration.ps1" -Directory "$INSTDIR" -ExecutableName "${APP_EXECUTABLE_FILENAME}" -EnvironmentKey "${DSH_COMMAND_ENVIRONMENT_KEY}" -OwnerKey "${DSH_COMMAND_OWNER_KEY}" -ProtocolKey "${DSH_PROTOCOL_KEY}" -ReportPath "$PLUGINSDIR\registration-report.txt" -MutexName "${DSH_COMMAND_MUTEX}" -UnownedMarker "$PLUGINSDIR\unowned-path" $UnRegistrationArguments'
  Pop $0
  Pop $1
  System::Call '$PLUGINSDIR\window-frame.dll::UninstallImport(p $UnSession, w "$PLUGINSDIR\registration-report.txt") ?c'
  ${If} $0 != 0
    StrCpy $UnCleanupResult 1
    DetailPrint $1
    ${If} $UnDirectoryOnly == 1
    ${AndIf} $UnRegistrationArguments != "-UnownedOnly"
      System::Call '$PLUGINSDIR\window-frame.dll::UninstallNote(p $UnSession, w "[unverified] Registration cleanup targets: HKCU\${UNINSTALL_REGISTRY_KEY}; $oldDesktopLink; $oldStartMenuLink") ?c'
      !ifdef UNINSTALL_REGISTRY_KEY_2
        System::Call '$PLUGINSDIR\window-frame.dll::UninstallNote(p $UnSession, w "[unverified] Registration cleanup target: HKCU\${UNINSTALL_REGISTRY_KEY_2}") ?c'
      !endif
    ${EndIf}
    System::Call '$PLUGINSDIR\window-frame.dll::UninstallNote(p $UnSession, w "Registration cleanup failed or did not return a result. Exit: $0. Targets: HKCU\${DSH_COMMAND_ENVIRONMENT_KEY} [Path]; HKCU\${DSH_COMMAND_OWNER_KEY}; HKCU\${DSH_PROTOCOL_KEY}. Unverified registrations may remain.") ?c'
  ${EndIf}
FunctionEnd
