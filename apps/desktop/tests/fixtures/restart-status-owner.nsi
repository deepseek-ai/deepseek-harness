; A private owner lets the test interrupt either process without touching an installation.
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "${OWNER_EXE}"
!include "LogicLib.nsh"
!include "${BANNER_INCLUDE}"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
LangString INSTALLER_UPDATE_WAIT ${LANG_ENGLISH} "Installing the $\"update$\". It's almost ready."
Var InstallerTheme
Section
  InitPluginsDir
  File "/oname=$PLUGINSDIR\window-frame.dll" "${STATUS_DLL}"
  StrCpy $InstallerTheme "dark"
  SetErrors
  !insertmacro ShowRestartBanner
  IfErrors +3
    SetErrorLevel 3
    Quit
  StrCpy $0 0
  wait:
    IfFileExists "$EXEDIR\finish-owner" done
    Sleep 50
    IntOp $0 $0 + 1
    IntCmp $0 400 timeout wait timeout
  timeout:
    SetErrorLevel 4
    Quit
  done:
    SetErrorLevel 0
SectionEnd
