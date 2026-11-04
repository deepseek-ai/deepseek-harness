!macro ShowRestartBanner
  Banner::show /NOUNLOAD /set 76 "$(INSTALLER_UPDATE_WAIT)" /set 1030 "$(INSTALLER_UPDATE_REOPEN)" "${PRODUCT_NAME}"
!macroend
