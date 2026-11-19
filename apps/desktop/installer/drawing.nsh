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
