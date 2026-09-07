@echo off
setlocal DisableDelayedExpansion
set "signTool=%DSH_DESKTOP_WINDOWS_SIGNTOOL%"
set "certificateFile=%DSH_DESKTOP_WINDOWS_CER_FILE%"
set "tokenPin=%DSH_DESKTOP_WINDOWS_TOKEN_PIN%"
set "keyContainer=%DSH_DESKTOP_WINDOWS_KEY_CONTAINER%"
set "targetFile=%DSH_DESKTOP_WINDOWS_SIGN_TARGET%"
set "appendSignature="
if "%DSH_DESKTOP_WINDOWS_SIGN_APPEND%"=="1" set "appendSignature=/as"
set "DSH_DESKTOP_WINDOWS_SIGNTOOL="
set "DSH_DESKTOP_WINDOWS_CER_FILE="
set "DSH_DESKTOP_WINDOWS_TOKEN_PIN="
set "DSH_DESKTOP_WINDOWS_KEY_CONTAINER="
set "DSH_DESKTOP_WINDOWS_SIGN_TARGET="
set "DSH_DESKTOP_WINDOWS_SIGN_APPEND="
set "signTool=" & set "certificateFile=" & set "tokenPin=" & set "keyContainer=" & set "targetFile=" & set "appendSignature=" & "%signTool%" sign /v /fd sha256 /f "%certificateFile%" /kc "[{{%tokenPin%}}]=%keyContainer%" /csp "eToken Base Cryptographic Provider" %appendSignature% /tr http://timestamp.digicert.com /td sha256 "%targetFile%"
exit /b %errorlevel%
