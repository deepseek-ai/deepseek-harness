; Compile with OUTPUT_FILE and RESULT_FILE in a private test directory, then run silently.
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Desktop installer cleanup smoke"
OutFile "${OUTPUT_FILE}"
!include "..\..\scripts\installer.nsh"

Section
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  CreateDirectory "$PLUGINSDIR\7z-out\nested"
  FileOpen $1 "$PLUGINSDIR\7z-out\nested\extracted-file" w
  FileWrite $1 "remove"
  FileClose $1
  FileOpen $1 "$PLUGINSDIR\archive.7z" w
  FileWrite $1 "archive sentinel"
  FileClose $1
  FileOpen $1 "$PLUGINSDIR\plugin.dll" w
  FileWrite $1 "plugin sentinel"
  FileClose $1
  CreateDirectory "$PLUGINSDIR\old-install"
  FileOpen $1 "$PLUGINSDIR\old-install\sentinel" w
  FileWrite $1 "rollback sentinel"
  FileClose $1

  StrCpy $0 "register sentinel"
  ClearErrors
  !insertmacro customInstall
  IfErrors failed
  StrCmp $0 "register sentinel" 0 failed
  StrCmp $OUTDIR $PLUGINSDIR 0 failed
  IfFileExists "$PLUGINSDIR\7z-out\*.*" failed

  FileOpen $1 "$PLUGINSDIR\archive.7z" r
  FileRead $1 $2
  FileClose $1
  StrCmp $2 "archive sentinel" 0 failed
  FileOpen $1 "$PLUGINSDIR\plugin.dll" r
  FileRead $1 $2
  FileClose $1
  StrCmp $2 "plugin sentinel" 0 failed
  FileOpen $1 "$PLUGINSDIR\old-install\sentinel" r
  FileRead $1 $2
  FileClose $1
  StrCmp $2 "rollback sentinel" 0 failed

  CreateDirectory "$PLUGINSDIR\7z-out"
  SetErrors
  !insertmacro customInstall
  IfErrors +2
    Goto failed
  IfFileExists "$PLUGINSDIR\7z-out\*.*" failed

  ClearErrors
  !insertmacro customInstall
  IfErrors failed
  FileOpen $1 "${RESULT_FILE}" w
  FileWrite $1 "scratch removed; archive, plugin, rollback, registers and error flags preserved"
  FileClose $1
  SetErrorLevel 0
  Quit

  failed:
  FileOpen $1 "${RESULT_FILE}" w
  FileWrite $1 "cleanup smoke failed"
  FileClose $1
  SetErrorLevel 1
  Quit
SectionEnd
