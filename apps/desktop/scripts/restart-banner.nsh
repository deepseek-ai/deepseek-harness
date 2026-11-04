!macro ShowRestartBanner
  Banner::show /NOUNLOAD /set 76 "$(INSTALLER_UPDATE_WAIT)" /set 1030 "$(INSTALLER_UPDATE_REOPEN)" "${PRODUCT_NAME}"
  Push $0
  Push $1
  Push $2
  Push $3
  Banner::getWindow /NOUNLOAD
  Pop $0
  ; The shell and the dialog image use different icon sizes from the same installer.
  System::Call 'shell32::ExtractIconExW(w "$EXEPATH", i 0, *p .r1, *p .r2, i 1) i.r3'
  ${If} $1 != 0
  ${AndIf} $2 != 0
    SendMessage $0 ${WM_SETICON} 1 $1
    SendMessage $0 ${WM_SETICON} 0 $2
    GetDlgItem $3 $0 -1
    SendMessage $3 0x170 $1 0
  ${EndIf}
  Pop $3
  Pop $2
  Pop $1
  Pop $0
!macroend
