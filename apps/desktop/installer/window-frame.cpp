// Keeps the DWM frame and shadow while the NSIS page owns the entire client area.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#include <windows.h>
#include <tlhelp32.h>
#include <objidl.h>
#include <commctrl.h>
#include <dwmapi.h>
#include <gdiplus.h>
#include <new>
#include <algorithm>
#include "progress.h"
#include "extract.h"
#include "extract-report.h"
#include "directory-report.h"
#include "uninstall-data.h"

using namespace Gdiplus;

// Returns whether the UTF-8 report was saved; failure still presents the original error unless silent.
extern "C" __declspec(dllexport) int __cdecl InstallerReportDirectoryFailure(
    HWND parent, DWORD error, LPCWSTR source, LPCWSTR destination, DWORD restoreError, LPCWSTR backup,
    LPCWSTR log, LPCWSTR reportPath, int show, LPCWSTR title, LPCWSTR heading, LPCWSTR hint, LPCWSTR copy,
    LPCWSTR expand, LPCWSTR collapse, LPCWSTR savedFormat, LPCWSTR unsaved, LPCWSTR copied) {
    try {
        const std::wstring report = directory_report::Compose(error, source, destination, restoreError, backup, extract_report::ReadOutput(log));
        const bool saved = extract_report::WriteUtf8(reportPath, report);
        if (show) {
            std::wstring footer = saved ? savedFormat : unsaved;
            const auto placeholder = footer.find(L"%s");
            if (saved && placeholder != std::wstring::npos) footer.replace(placeholder, 2, reportPath);
            const extract_report::DialogStrings strings{title, heading, copy, expand, collapse, footer.c_str(), copied};
            const std::wstring content = directory_report::Content(error, hint, restoreError, backup);
            extract_report::Show(parent, content, extract_report::BoundedExcerpt(extract_report::Lines(extract_report::Trim(report))), report, strings);
        }
        return saved ? 1 : 0;
    } catch (const std::bad_alloc&) {
        if (show) MessageBoxW(parent, hint, heading, MB_OK | MB_ICONEXCLAMATION);
        return 0;
    }
}

// Saves the extraction failure report and, unless silent, presents its headline with a copy action.
// Returns 1 when the report file was written and 0 otherwise; the dialog outcome never fails the caller.
extern "C" __declspec(dllexport) int __cdecl InstallerReportExtractFailure(
    HWND parent, int code, LPCWSTR archive, LPCWSTR destination, LPCWSTR log, LPCWSTR reportPath, int show,
    LPCWSTR title, LPCWSTR heading, LPCWSTR hint, LPCWSTR copy, LPCWSTR expand, LPCWSTR collapse, LPCWSTR savedFormat, LPCWSTR unsaved, LPCWSTR copied) {
    try {
        const std::wstring output = extract_report::ReadOutput(log);
        const std::wstring report = extract_report::Compose(code, archive, destination, output,
            extract_report::Timestamp(), extract_report::WindowsVersion());
        const bool saved = extract_report::WriteUtf8(reportPath, report);
        if (show) {
            std::wstring footer = saved ? savedFormat : unsaved;
            const auto placeholder = footer.find(L"%s");
            if (saved && placeholder != std::wstring::npos) footer.replace(placeholder, 2, reportPath);
            const extract_report::DialogStrings strings{title, heading, copy, expand, collapse, footer.c_str(), copied};
            const std::wstring content = extract_report::Headline(code, output, archive) + L"\r\n\r\n" + hint;
            extract_report::Show(parent, content, extract_report::Excerpt(report), report, strings);
        }
        return saved ? 1 : 0;
    } catch (const std::bad_alloc&) {
        return 0;
    }
}

// Returns a Win32 error code; no cleanup request may traverse a linked root or touch the protected root.
extern "C" __declspec(dllexport) DWORD __cdecl UninstallRemoveData(LPCWSTR path, LPCWSTR installation, LPCWSTR protectedRoot) {
    return uninstall_data::Remove(path, installation, protectedRoot);
}

// Returns a Win32 error code; only ordinary empty directories strictly below the stop directory are removed.
extern "C" __declspec(dllexport) DWORD __cdecl UninstallRemoveEmptyParents(LPCWSTR path, LPCWSTR stop) {
    return uninstall_data::RemoveEmptyParents(path, stop);
}

// Match the affected executable, not another user's or directory's same-named application.
// Returns 0 while running, 1 when absent, and -1 if the process list cannot be read.
extern "C" __declspec(dllexport) int __cdecl InstallerFindProcess(LPCWSTR executable) {
    WCHAR target[32768];
    DWORD length = GetLongPathNameW(executable, target, ARRAYSIZE(target));
    LPCWSTR expected = length > 0 && length < ARRAYSIZE(target) ? target : executable;
    LPCWSTR filename = wcsrchr(expected, L'\\');
    filename = filename ? filename + 1 : expected;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (snapshot == INVALID_HANDLE_VALUE) return -1;
    PROCESSENTRY32W entry = {};
    entry.dwSize = sizeof(entry);
    int result = 1;
    BOOL present = Process32FirstW(snapshot, &entry);
    while (present) {
        if (_wcsicmp(entry.szExeFile, filename) == 0) {
            HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, entry.th32ProcessID);
            if (process) {
                WCHAR path[32768];
                DWORD count = ARRAYSIZE(path);
                if (QueryFullProcessImageNameW(process, 0, path, &count) && _wcsicmp(path, expected) == 0) result = 0;
                CloseHandle(process);
                if (result == 0) break;
            }
        }
        present = Process32NextW(snapshot, &entry);
    }
    if (!present && GetLastError() != ERROR_NO_MORE_FILES) result = -1;
    CloseHandle(snapshot);
    return result;
}

struct ProgressPage {
    InstallProgress progress{GetTickCount64()};
    bool dark;
    UINT dpi;
    ULONG_PTR gdiplus;
    Image* brand;
    Bitmap* buffer;
    HDC bufferDc;
    HBITMAP bufferBitmap;
    HGDIOBJ previousBitmap;
    UINT pressedCommand;
    UINT hoveredCommand;
    ARGB controlHover;
    ARGB controlPressed;
    WCHAR captions[5][128];

    ~ProgressPage() {
        delete buffer;
        delete brand;
        if (previousBitmap) SelectObject(bufferDc, previousBitmap);
        if (bufferBitmap) DeleteObject(bufferBitmap);
        if (bufferDc) DeleteDC(bufferDc);
        if (gdiplus) GdiplusShutdown(gdiplus);
    }
};

// NSIS shows its page after MUI's SHOW callback; keep its controls off screen.
static LRESULT CALLBACK HiddenPageProc(HWND window, UINT message, WPARAM wparam,
                                      LPARAM lparam, UINT_PTR id, DWORD_PTR) {
    if (message == WM_WINDOWPOSCHANGING) {
        auto* position = reinterpret_cast<WINDOWPOS*>(lparam);
        position->flags = (position->flags & ~SWP_SHOWWINDOW) | SWP_HIDEWINDOW;
    }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, HiddenPageProc, id);
    return DefSubclassProc(window, message, wparam, lparam);
}

static void FillProgress(Graphics& graphics, Brush& brush, REAL width) {
    if (width <= 0) return;
    if (width < 4) { graphics.FillRectangle(&brush, 64.0f, 482.0f, width, 6.0f); return; }
    GraphicsPath path;
    path.AddArc(64.0f, 482.0f, 4.0f, 4.0f, 180.0f, 90.0f);
    path.AddArc(64.0f + width - 4, 482.0f, 4.0f, 4.0f, 270.0f, 90.0f);
    path.AddArc(64.0f + width - 4, 484.0f, 4.0f, 4.0f, 0.0f, 90.0f);
    path.AddArc(64.0f, 484.0f, 4.0f, 4.0f, 90.0f, 90.0f);
    path.CloseFigure();
    graphics.FillPath(&brush, &path);
}

static UINT CaptionCommand(const ProgressPage& page, LPARAM position) {
    const int x = static_cast<short>(LOWORD(position));
    const int y = static_cast<short>(HIWORD(position));
    if (y < 0 || y >= MulDiv(48, page.dpi, 96) || x < MulDiv(504, page.dpi, 96) || x >= MulDiv(600, page.dpi, 96)) return 0;
    return x >= MulDiv(548, page.dpi, 96) ? SC_CLOSE : SC_MINIMIZE;
}

static void PaintCaptionButtons(Graphics& graphics, const ProgressPage& page) {
    SolidBrush background(page.dark ? Color(255, 21, 21, 23) : Color(255, 255, 255, 255));
    graphics.FillRectangle(&background, 504, 0, 96, 48);
    SolidBrush ink(page.dark ? Color(255, 255, 255, 255) : Color(255, 15, 17, 21));
    FontFamily family(L"Microsoft YaHei UI");
    Font font(&family, 16, FontStyleRegular, UnitPixel);
    StringFormat centered;
    centered.SetAlignment(StringAlignmentCenter);
    centered.SetLineAlignment(StringAlignmentCenter);
    for (UINT command : {SC_MINIMIZE, SC_CLOSE}) {
        const int x = command == SC_MINIMIZE ? 504 : 548;
        if (page.hoveredCommand == command && (!page.pressedCommand || page.pressedCommand == command)) {
            const bool pressed = page.pressedCommand == command;
            SolidBrush fill(Color(pressed ? page.controlPressed : page.controlHover));
            GraphicsPath path;
            path.AddArc(x, 8, 20, 20, 180, 90);
            path.AddArc(x + 20, 8, 20, 20, 270, 90);
            path.AddArc(x + 20, 20, 20, 20, 0, 90);
            path.AddArc(x, 20, 20, 20, 90, 90);
            path.CloseFigure();
            graphics.FillPath(&fill, &path);
        }
        graphics.DrawString(command == SC_MINIMIZE ? L"\x2212" : L"\x00d7", -1,
            &font, RectF(static_cast<REAL>(x), 8, 40, 32), &centered, &ink);
    }
}

static void InvalidateCaptionButtons(HWND window, const ProgressPage& page) {
    RECT bounds{MulDiv(504, page.dpi, 96), 0, MulDiv(600, page.dpi, 96), MulDiv(48, page.dpi, 96)};
    InvalidateRect(window, &bounds, FALSE);
}

static LRESULT CALLBACK ProgressProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* page = reinterpret_cast<ProgressPage*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_CREATE) {
        page = static_cast<ProgressPage*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(page));
        SetTimer(window, 1, 16, nullptr);
    }
    if (message == WM_ERASEBKGND) return 1;
    if (message == WM_TIMER) { InvalidateRect(window, nullptr, FALSE); return 0; }
    if (message == WM_MOUSEMOVE && page) {
        TRACKMOUSEEVENT tracking{sizeof(tracking), TME_LEAVE, window, 0};
        TrackMouseEvent(&tracking);
        const UINT hovered = CaptionCommand(*page, lparam);
        if (page->hoveredCommand != hovered) {
            page->hoveredCommand = hovered;
            InvalidateCaptionButtons(window, *page);
        }
        return 0;
    }
    if (message == WM_MOUSELEAVE && page) {
        page->hoveredCommand = 0;
        InvalidateCaptionButtons(window, *page);
        return 0;
    }
    if (message == WM_LBUTTONDOWN && page) {
        const int x = static_cast<short>(LOWORD(lparam));
        const int y = static_cast<short>(HIWORD(lparam));
        page->pressedCommand = CaptionCommand(*page, lparam);
        if (page->pressedCommand) {
            page->hoveredCommand = page->pressedCommand;
            SetCapture(window);
            InvalidateCaptionButtons(window, *page);
        }
        else if (x >= 0 && x < MulDiv(504, page->dpi, 96) && y >= 0 && y < MulDiv(48, page->dpi, 96)) {
            HWND parent = GetParent(window);
            ReleaseCapture(); SendMessageW(parent, WM_NCLBUTTONDOWN, HTCAPTION, 0);
        }
        return 0;
    }
    if (message == WM_LBUTTONUP && page) {
        const UINT command = page->pressedCommand;
        page->pressedCommand = 0;
        page->hoveredCommand = CaptionCommand(*page, lparam);
        InvalidateCaptionButtons(window, *page);
        const bool activate = command && GetCapture() == window && CaptionCommand(*page, lparam) == command;
        if (GetCapture() == window) ReleaseCapture();
        if (activate) {
            if (command == SC_CLOSE) PostMessageW(GetParent(window), WM_CLOSE, 0, 0);
            else ShowWindow(GetParent(window), SW_MINIMIZE);
        }
        return 0;
    }
    if ((message == WM_CAPTURECHANGED || message == WM_CANCELMODE) && page) {
        page->pressedCommand = 0;
        InvalidateCaptionButtons(window, *page);
        if (message == WM_CANCELMODE && GetCapture() == window) ReleaseCapture();
        return 0;
    }
    if ((message == WM_PAINT || message == WM_PRINTCLIENT) && page) {
        PAINTSTRUCT paint = {};
        const bool printing = message == WM_PRINTCLIENT;
        HDC dc = printing ? reinterpret_cast<HDC>(wparam) : BeginPaint(window, &paint);
        if (printing) GetClientRect(window, &paint.rcPaint);
        {
            Graphics graphics(page->buffer);
            graphics.ScaleTransform(page->dpi / 96.0f, page->dpi / 96.0f);
            graphics.SetSmoothingMode(SmoothingModeAntiAlias);
            graphics.SetPixelOffsetMode(PixelOffsetModeHalf);
            PaintCaptionButtons(graphics, *page);
            SolidBrush background(page->dark ? Color(255, 21, 21, 23) : Color(255, 255, 255, 255));
            graphics.FillRectangle(&background, 48, 480, 504, 56);
            const int stage = static_cast<int>(reinterpret_cast<INT_PTR>(GetPropW(GetParent(window), L"HarnessInstaller.Stage")));
            const double fraction = reinterpret_cast<UINT_PTR>(GetPropW(GetParent(window), L"HarnessInstaller.ExtractProgress")) / 100.0;
            page->progress.Advance(stage, fraction, GetTickCount64());
            const int percent = static_cast<int>(page->progress.value);
            SolidBrush track(page->dark ? Color(255, 97, 102, 107) : Color(255, 233, 236, 242));
            SolidBrush ink(page->dark ? Color(255, 255, 255, 255) : Color(255, 15, 17, 21));
            FillProgress(graphics, track, 472.0f);
            FillProgress(graphics, ink, 472.0f * static_cast<REAL>(page->progress.value) / 100);
            FontFamily family(L"Microsoft YaHei UI");
            Font font(&family, 14, FontStyleRegular, UnitPixel);
            StringFormat centered;
            centered.SetAlignment(StringAlignmentCenter);
            centered.SetLineAlignment(StringAlignmentCenter);
            WCHAR caption[160];
            wsprintfW(caption, page->captions[page->progress.CaptionStage()], percent);
            SetWindowTextW(window, caption);
            graphics.DrawString(caption, -1, &font, RectF(48, 512, 504, 22), &centered, &ink);
        }
        BitBlt(dc, paint.rcPaint.left, paint.rcPaint.top,
               paint.rcPaint.right - paint.rcPaint.left, paint.rcPaint.bottom - paint.rcPaint.top,
               page->bufferDc, paint.rcPaint.left, paint.rcPaint.top, SRCCOPY);
        if (!printing) EndPaint(window, &paint);
        if (page->progress.value == 100) SetPropW(GetParent(window), L"HarnessInstaller.CompletedPercent", reinterpret_cast<HANDLE>(100));
        return 0;
    }
    if (message == WM_NCDESTROY && page) {
        KillTimer(window, 1);
        delete page;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

// Runs on the NSIS UI thread; the stock installation section runs on its worker.
// Caption colors are opaque ARGB from NSIS; failure preserves the stock page's visibility.
extern "C" __declspec(dllexport) HWND __cdecl InstallerShowProgress(HWND parent, HWND source,
        BOOL dark, UINT dpi, ARGB controlHover, ARGB controlPressed, const WCHAR* brand, const WCHAR* preparing, const WCHAR* extracting,
        const WCHAR* copying, const WCHAR* registering, const WCHAR* cleaning) {
    HINSTANCE module = GetModuleHandleW(nullptr);
    WNDCLASSW type = {};
    type.lpfnWndProc = ProgressProc;
    type.hInstance = module;
    type.lpszClassName = L"HarnessInstallerProgress";
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    RegisterClassW(&type);
    auto* page = new (std::nothrow) ProgressPage{};
    if (!page) return nullptr;
    GdiplusStartupInput startup;
    if (GdiplusStartup(&page->gdiplus, &startup, nullptr) != Ok) { delete page; return nullptr; }
    page->dark = dark != FALSE;
    page->dpi = dpi;
    page->controlHover = controlHover;
    page->controlPressed = controlPressed;
    const WCHAR* captions[] = {preparing, extracting, copying, registering, cleaning};
    for (int i = 0; i < 5; ++i) lstrcpynW(page->captions[i], captions[i], 128);
    page->brand = new Image(brand);
    if (!page->brand || page->brand->GetLastStatus() != Ok) {
        delete page; return nullptr;
    }
    const int size = MulDiv(600, dpi, 96);
    BITMAPINFO info = {};
    info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
    info.bmiHeader.biWidth = size;
    info.bmiHeader.biHeight = -size;
    info.bmiHeader.biPlanes = 1;
    info.bmiHeader.biBitCount = 32;
    info.bmiHeader.biCompression = BI_RGB;
    void* pixels = nullptr;
    page->bufferDc = CreateCompatibleDC(nullptr);
    page->bufferBitmap = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
    if (!page->bufferDc || !page->bufferBitmap) { delete page; return nullptr; }
    page->previousBitmap = SelectObject(page->bufferDc, page->bufferBitmap);
    if (!page->previousBitmap) { delete page; return nullptr; }
    // Opaque pixels are shared by GDI+ drawing and the window's GDI blit.
    page->buffer = new Bitmap(size, size, size * 4, PixelFormat32bppPARGB, static_cast<BYTE*>(pixels));
    if (!page->buffer || page->buffer->GetLastStatus() != Ok) { delete page; return nullptr; }
    {
        // Static artwork stays in the buffer for this page's lifetime.
        Graphics graphics(page->buffer);
        graphics.ScaleTransform(dpi / 96.0f, dpi / 96.0f);
        graphics.Clear(page->dark ? Color(255, 21, 21, 23) : Color(255, 255, 255, 255));
        graphics.SetSmoothingMode(SmoothingModeAntiAlias);
        graphics.SetInterpolationMode(InterpolationModeHighQualityBicubic);
        graphics.SetPixelOffsetMode(PixelOffsetModeHalf);
        graphics.DrawImage(page->brand, Rect(0, 174, 600, 196));
        PaintCaptionButtons(graphics, *page);
    }
    delete page->brand;
    page->brand = nullptr;
    HWND window = CreateWindowExW(0, type.lpszClassName, L"", WS_CHILD,
        0, 0, MulDiv(600, dpi, 96), MulDiv(600, dpi, 96), parent, nullptr, module, page);
    if (!window) { delete page; return nullptr; }
    // Keep the stock page available until the replacement is fully constructed.
    HWND stockPage = GetParent(source);
    if (!SetWindowSubclass(stockPage, HiddenPageProc, 1, 0)) {
        DestroyWindow(window); return nullptr;
    }
    ShowWindow(stockPage, SW_HIDE);
    ShowWindow(window, SW_SHOW);
    return window;
}

// NSIS has already reported success. Pump the UI for the bounded final animation,
// including a painted 100% frame, before constructing the interactive finish page.
extern "C" __declspec(dllexport) BOOL __cdecl InstallerFinishProgress(HWND window) {
    auto* page = reinterpret_cast<ProgressPage*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (!page) return FALSE;
    const ULONGLONG started = GetTickCount64();
    SetPropW(GetParent(window), L"HarnessInstaller.Succeeded", reinterpret_cast<HANDLE>(1));
    page->progress.Complete(started);
    while (IsWindow(window) && GetTickCount64() - started < 750) {
        MSG message;
        if (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
            if (message.message == WM_QUIT) { PostQuitMessage(static_cast<int>(message.wParam)); return FALSE; }
            TranslateMessage(&message);
            DispatchMessageW(&message);
        } else {
            MsgWaitForMultipleObjectsEx(0, nullptr, 16, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        }
    }
    if (!IsWindow(window)) return FALSE;
    InvalidateRect(window, nullptr, FALSE);
    UpdateWindow(window);
    return TRUE;
}

static LRESULT CALLBACK FrameProc(HWND window, UINT message, WPARAM wparam,
                                 LPARAM lparam, UINT_PTR id, DWORD_PTR) {
    if (message == WM_NCCALCSIZE && wparam) return 0;
    // Activation must not repaint the standard frame over the custom client area.
    if (message == WM_NCACTIVATE) return DefSubclassProc(window, message, wparam, -1);
    if (message == WM_NCHITTEST) {
        const LRESULT hit = DefSubclassProc(window, message, wparam, lparam);
        // The installer has a fixed size; its page provides the drag area.
        return hit >= HTLEFT && hit <= HTBOTTOMRIGHT ? HTCLIENT : hit;
    }
    if (message == WM_NCDESTROY) RemoveWindowSubclass(window, FrameProc, id);
    return DefSubclassProc(window, message, wparam, lparam);
}

extern "C" __declspec(dllexport) HRESULT __cdecl InstallerApplyFrame(HWND window) {
    // NSIS may release its DLL reference before the window receives WM_NCDESTROY.
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
                           reinterpret_cast<LPCWSTR>(&FrameProc), &module)) return E_FAIL;
    if (!SetWindowSubclass(window, FrameProc, 1, 0)) return E_FAIL;
    const int stockControls[] = {1, 2, 3, 1028, 1256, 1034, 1035, 1036, 1037, 1038, 1039};
    for (int id : stockControls) {
        HWND child = GetDlgItem(window, id);
        if (child) {
            if (!SetWindowSubclass(child, HiddenPageProc, 1, 0)) return E_FAIL;
            ShowWindow(child, SW_HIDE);
        }
    }
    // DWM retains native transitions; WM_NCCALCSIZE removes the visible caption.
    SetWindowLongW(window, GWL_STYLE, GetWindowLongW(window, GWL_STYLE) | WS_THICKFRAME | WS_CAPTION);
    const DWMNCRENDERINGPOLICY policy = DWMNCRP_ENABLED;
    HRESULT result = DwmSetWindowAttribute(window, DWMWA_NCRENDERING_POLICY, &policy, sizeof(policy));
    if (FAILED(result)) return result;
    const DWORD rounded = 2;
    // Windows 10 does not support the Windows 11 corner preference.
    DwmSetWindowAttribute(window, 33, &rounded, sizeof(rounded));
    const MARGINS margins = {1, 1, 1, 1};
    result = DwmExtendFrameIntoClientArea(window, &margins);
    SetWindowPos(window, nullptr, 0, 0, 0, 0,
                 SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
    return result;
}

// Present the first interactive page after resource preparation without keeping the installer topmost.
extern "C" __declspec(dllexport) BOOL __cdecl InstallerPresentWelcome(HWND window) {
    if (!IsWindowVisible(window)) return FALSE;
    if (!SetWindowPos(window, HWND_TOP, 0, 0, 0, 0,
                      SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE)) return FALSE;
    if (GetForegroundWindow() != window) {
        FLASHWINFO flash = {sizeof(flash), window, FLASHW_TRAY | FLASHW_TIMERNOFG, 0, 0};
        FlashWindowEx(&flash);
    }
    SetPropW(window, L"HarnessInstaller.Presented", reinterpret_cast<HANDLE>(1));
    return TRUE;
}
