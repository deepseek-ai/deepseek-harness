Var InstallerProgressWindow

Function InstallerGuiInit
    HideWindow
    System::Call 'user32::SetWindowLongW(p $HWNDPARENT, i -16, i 0x800A0000)'
    System::Call 'user32::GetDC(p $HWNDPARENT) p.r0'
    System::Call 'gdi32::GetDeviceCaps(p r0, i 88) i.s'
    Pop $InstallerDpi
    System::Call 'user32::ReleaseDC(p $HWNDPARENT, p r0)'
    System::Call 'kernel32::MulDiv(i 600, i $InstallerDpi, i 96) i.s'
    Pop $InstallerSize
    System::Call 'user32::GetSystemMetrics(i 0) i.r0'
    System::Call 'user32::GetSystemMetrics(i 1) i.r1'
    IntOp $0 $0 - $InstallerSize
    IntOp $0 $0 / 2
    IntOp $1 $1 - $InstallerSize
    IntOp $1 $1 / 2
    System::Call 'user32::SetWindowPos(p $HWNDPARENT, p 0, i r0, i r1, i $InstallerSize, i $InstallerSize, i 0x34)'
    System::Call '$PLUGINSDIR\window-frame.dll::InstallerApplyFrame(p $HWNDPARENT) i.r0 ?c'
    ${If} $0 < 0
        MessageBox MB_OK|MB_ICONSTOP "$(INSTALLER_UI_ERROR)"
        SetErrorLevel 2
        Quit
    ${EndIf}
    GetDlgItem $0 $HWNDPARENT 1
    ShowWindow $0 0
    GetDlgItem $0 $HWNDPARENT 2
    ShowWindow $0 0
    GetDlgItem $0 $HWNDPARENT 3
    ShowWindow $0 0
    GetDlgItem $0 $HWNDPARENT 1028
    ShowWindow $0 0
    GetDlgItem $0 $HWNDPARENT 1256
    ShowWindow $0 0
FunctionEnd

Function InstallerWelcome
    ${If} ${isUpdated}
        Abort
    ${EndIf}
    StrCpy $InstallerPhase "welcome"
    Call InstallerCreate
FunctionEnd

Function InstallerBeforeInstall
    SetAutoClose true
    Call InstallerPreflight
    ${If} $InstallerError != ""
        MessageBox MB_OK|MB_ICONEXCLAMATION "$InstallerError" /SD IDOK
        SetErrorLevel 2
        Quit
    ${EndIf}
    Call InstallerCheckAppRunning
FunctionEnd

Function InstallerProgressShow
    ; Only the stock worker executes installation; this overlay runs on the UI thread.
    ShowWindow $mui.InstFilesPage 0
    StrCpy $0 0
    StrCpy $1 "$PLUGINSDIR\brand-2x.bmp"
    ${If} $InstallerTheme == "dark"
        StrCpy $0 1
        StrCpy $1 "$PLUGINSDIR\brand-dark-2x.bmp"
    ${EndIf}
    System::Call '$PLUGINSDIR\window-frame.dll::InstallerShowProgress(p $HWNDPARENT, p $mui.InstFilesPage.ProgressBar, i r0, i $InstallerDpi, w r1, w "$(INSTALLER_NATIVE_PROGRESS)", w "$(INSTALLER_PROGRESS_EXTRACT)", w "$(INSTALLER_PROGRESS_COPY)", w "$(INSTALLER_PROGRESS_REGISTER)", w "$(INSTALLER_PROGRESS_CLEAN)") p.s ?c'
    Pop $InstallerProgressWindow
    ${If} $InstallerProgressWindow == 0
        MessageBox MB_OK|MB_ICONSTOP "$(INSTALLER_UI_ERROR)"
        SetErrorLevel 2
        Quit
    ${EndIf}
    System::Call 'user32::SetPropW(p $HWNDPARENT, w "HarnessInstaller.Ready", p 1)'
    ShowWindow $HWNDPARENT 5
FunctionEnd

Function .onInstFailed
    MessageBox MB_OK|MB_ICONEXCLAMATION "$(INSTALLER_FAILED)" /SD IDOK
    SetErrorLevel 2
    Quit
FunctionEnd

Function InstallerFinish
    System::Call '$PLUGINSDIR\window-frame.dll::InstallerFinishProgress(p $InstallerProgressWindow) i.r0 ?c'
    ${If} $0 == 0
        Quit
    ${EndIf}
    System::Call 'user32::DestroyWindow(p $InstallerProgressWindow)'
    StrCpy $InstallerPhase "success"
    Call InstallerCreate
FunctionEnd
