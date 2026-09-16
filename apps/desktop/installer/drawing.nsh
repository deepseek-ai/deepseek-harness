; Windows GDI+ supplies antialiasing for the native controls.
Var InstallerGdiToken
Var InstallerEditFrameBitmap

!macro InstallerPixelFont HANDLE SIZE WEIGHT
    System::Call 'kernel32::MulDiv(i -${SIZE}, i $InstallerDpi, i 96) i.r0'
    System::Call 'gdi32::CreateFontW(i r0, i 0, i 0, i 0, i ${WEIGHT}, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "${INSTALLER_FONT}") p.s'
    Pop ${HANDLE}
!macroend

; Produces a closed rounded rectangle. Inputs and output must not use $0/$1.
!macro InstallerRoundPath PATH WIDTH HEIGHT DIAMETER
    System::Call 'gdiplus::GdipCreatePath(i 0, *p .s)'
    Pop ${PATH}
    IntOp $0 ${WIDTH} - ${DIAMETER}
    IntOp $1 ${HEIGHT} - ${DIAMETER}
    ; System.dll has no float argument type. The arc angles use IEEE-754 bits.
    System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i 0, i 0, i ${DIAMETER}, i ${DIAMETER}, i 0x43340000, i 0x42B40000)'
    System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i r0, i 0, i ${DIAMETER}, i ${DIAMETER}, i 0x43870000, i 0x42B40000)'
    System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i r0, i r1, i ${DIAMETER}, i ${DIAMETER}, i 0, i 0x42B40000)'
    System::Call 'gdiplus::GdipAddPathArcI(p ${PATH}, i 0, i r1, i ${DIAMETER}, i ${DIAMETER}, i 0x42B40000, i 0x42B40000)'
    System::Call 'gdiplus::GdipClosePathFigure(p ${PATH})'
!macroend

Function InstallerDrawEditFrame
    System::Call 'kernel32::MulDiv(i 384, i $InstallerDpi, i 96) i.R7'
    System::Call 'kernel32::MulDiv(i 34, i $InstallerDpi, i 96) i.R8'
    System::Call 'kernel32::MulDiv(i 12, i $InstallerDpi, i 96) i.R3'
    System::Call 'gdiplus::GdipCreateBitmapFromScan0(i R7, i R8, i 0, i 0x26200A, p 0, *p .R5)'
    System::Call 'gdiplus::GdipGetImageGraphicsContext(p R5, *p .R4)'
    System::Call 'gdiplus::GdipGraphicsClear(p R4, i $InstallerBgArgb)'
    System::Call 'gdiplus::GdipSetSmoothingMode(p R4, i 4)'
    IntOp $R7 $R7 - 1
    IntOp $R8 $R8 - 1
    !insertmacro InstallerRoundPath $R6 $R7 $R8 $R3
    System::Call 'gdiplus::GdipCreatePen1(i $InstallerBorder, i 0x40000000, i 2, *p .R1)'
    System::Call 'gdiplus::GdipDrawPath(p R4, p R1, p R6)'
    System::Call 'gdiplus::GdipCreateHBITMAPFromBitmap(p R5, *p .s, i $InstallerBgArgb)'
    Pop $InstallerEditFrameBitmap
    SendMessage $InstallerEditFrame ${STM_SETIMAGE} ${IMAGE_BITMAP} $InstallerEditFrameBitmap
    System::Call 'gdiplus::GdipDeletePen(p R1)'
    System::Call 'gdiplus::GdipDeletePath(p R6)'
    System::Call 'gdiplus::GdipDeleteGraphics(p R4)'
    System::Call 'gdiplus::GdipDisposeImage(p R5)'
FunctionEnd

; BS_AUTOCHECKBOX retains its native state, text, keyboard and accessibility role.
Function InstallerPaintCheckbox
    Pop $R0
    Pop $R1
    Pop $R2
    ${If} $R1 != -12
        Return
    ${EndIf}
    System::Call '*$R2(p, p, i, i .R3, p .R4, i, i, i, i, p, i .R9)'
    ${If} $R3 != 1
        Return
    ${EndIf}
    System::Call 'gdi32::SaveDC(p R4)'
    System::Alloc 16
    Pop $R2
    System::Call 'user32::GetClientRect(p R0, p R2)'
    System::Call 'gdi32::CreateSolidBrush(i $InstallerBgColorref) p.R3'
    System::Call 'user32::FillRect(p R4, p R2, p R3)'
    System::Call 'gdi32::DeleteObject(p R3)'
    System::Call 'kernel32::MulDiv(i 8, i $InstallerDpi, i 96) i.r2'
    System::Call 'kernel32::MulDiv(i 7, i $InstallerDpi, i 96) i.r3'
    System::Call 'gdi32::SetViewportOrgEx(p R4, i r2, i r3, p 0)'
    System::Call 'gdiplus::GdipCreateFromHDC(p R4, *p .R5)'
    System::Call 'gdiplus::GdipSetSmoothingMode(p R5, i 4)'
    System::Call 'kernel32::MulDiv(i 18, i $InstallerDpi, i 96) i.R7'
    StrCpy $R8 $R7
    System::Call 'kernel32::MulDiv(i 6, i $InstallerDpi, i 96) i.R3'
    !insertmacro InstallerRoundPath $R6 $R7 $R8 $R3
    ${NSD_GetState} $R0 $R8
    StrCpy $R3 $InstallerBgArgb
    ${If} $R8 == ${BST_CHECKED}
        StrCpy $R3 $InstallerPrimary
    ${EndIf}
    System::Call 'gdiplus::GdipCreateSolidFill(i R3, *p .R1)'
    System::Call 'gdiplus::GdipFillPath(p R5, p R1, p R6)'
    System::Call 'gdiplus::GdipDeleteBrush(p R1)'
    ${If} $R8 != ${BST_CHECKED}
        System::Call 'gdiplus::GdipCreatePen1(i $InstallerBorder, i 0x40000000, i 2, *p .R1)'
        System::Call 'gdiplus::GdipDrawPath(p R5, p R1, p R6)'
        System::Call 'gdiplus::GdipDeletePen(p R1)'
    ${EndIf}
    System::Call 'gdiplus::GdipDeletePath(p R6)'
    System::Call 'gdiplus::GdipDeleteGraphics(p R5)'
    ${If} $R8 == ${BST_CHECKED}
        System::Call 'kernel32::MulDiv(i 2, i $InstallerDpi, i 96) i.r0'
        System::Call 'gdi32::CreatePen(i 0, i r0, i $InstallerButtonText) p.R1'
        System::Call 'gdi32::SelectObject(p R4, p R1) p.R3'
        System::Call 'kernel32::MulDiv(i 4, i $InstallerDpi, i 96) i.r0'
        System::Call 'kernel32::MulDiv(i 9, i $InstallerDpi, i 96) i.r1'
        System::Call 'gdi32::MoveToEx(p R4, i r0, i r1, p 0)'
        System::Call 'kernel32::MulDiv(i 8, i $InstallerDpi, i 96) i.r0'
        System::Call 'kernel32::MulDiv(i 13, i $InstallerDpi, i 96) i.r1'
        System::Call 'gdi32::LineTo(p R4, i r0, i r1)'
        System::Call 'kernel32::MulDiv(i 14, i $InstallerDpi, i 96) i.r0'
        System::Call 'kernel32::MulDiv(i 5, i $InstallerDpi, i 96) i.r1'
        System::Call 'gdi32::LineTo(p R4, i r0, i r1)'
        System::Call 'gdi32::SelectObject(p R4, p R3)'
        System::Call 'gdi32::DeleteObject(p R1)'
    ${EndIf}
    System::Call 'gdi32::SetViewportOrgEx(p R4, i 0, i 0, p 0)'
    System::Call 'kernel32::MulDiv(i 34, i $InstallerDpi, i 96) i.r0'
    System::Call '*$R2(i r0)'
    System::Call 'gdi32::SetBkMode(p R4, i 1)'
    System::Call 'gdi32::SetTextColor(p R4, i $InstallerTextColorref)'
    System::Call 'gdi32::SelectObject(p R4, p $InstallerSmallFont)'
    System::Call 'user32::DrawTextW(p R4, w "$(INSTALLER_LAUNCH)", i -1, p R2, i 0x24)'
    IntOp $R9 $R9 & 16
    ${If} $R9 != 0
        System::Call 'user32::DrawFocusRect(p R4, p R2)'
    ${EndIf}
    System::Call 'gdi32::RestoreDC(p R4, i -1)'
    System::Free $R2
    ${NSD_Return} 4
FunctionEnd
