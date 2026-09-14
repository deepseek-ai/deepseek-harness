; Compile with OUTPUT_FILE, RESULT_FILE, PAYLOAD_FILE, TARGET_DIR and PLUGIN_DIR.
; All paths must belong to a private test directory, except the NSIS plugin directory.
; PAYLOAD_FILE contains locked.txt="new runtime" and asset.txt="new asset".
; Before running /S, create TARGET_DIR\locked.txt="old runtime" and hold it open
; for reading with FileShare.Read until the native process exits. asset.txt is absent.
; Define DIRECT for direct extraction; otherwise extract to temporary files and copy.
; Both modes retain "old runtime" and write "new asset" under that lock. The copy
; sets errorFlag=true; direct extraction reports false despite the mixed versions.
; Exit code 0 alone cannot establish successful extraction; inspect RESULT_FILE.
Unicode true
RequestExecutionLevel user
SilentInstall silent
Name "Desktop occupied-file extraction smoke"
OutFile "${OUTPUT_FILE}"
!addplugindir /x86-unicode "${PLUGIN_DIR}"

Section
  InitPluginsDir
  SetOutPath "${TARGET_DIR}"
  !ifdef DIRECT
    ClearErrors
    Nsis7z::Extract "${PAYLOAD_FILE}"
  !else
    SetOutPath "$PLUGINSDIR\7z-out"
    Nsis7z::Extract "${PAYLOAD_FILE}"
    SetOutPath "${TARGET_DIR}"
    ClearErrors
    CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" $OUTDIR
  !endif

  StrCpy $0 "false"
  IfErrors 0 +2
    StrCpy $0 "true"
  ClearErrors
  FileOpen $1 "${RESULT_FILE}" w
  IfErrors failed
  FileWrite $1 "errorFlag=$0$\r$\n"
  FileOpen $2 "${TARGET_DIR}\locked.txt" r
  IfErrors failed
  FileRead $2 $3
  FileClose $2
  FileWrite $1 "locked=$3$\r$\n"
  FileOpen $2 "${TARGET_DIR}\asset.txt" r
  IfErrors failed
  FileRead $2 $3
  FileClose $2
  FileWrite $1 "asset=$3$\r$\n"
  FileClose $1
  SetErrorLevel 0
  Quit

  failed:
  SetErrorLevel 1
  Quit
SectionEnd
