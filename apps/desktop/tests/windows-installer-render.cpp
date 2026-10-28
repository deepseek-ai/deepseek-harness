// Exercises the shipped progress window without extracting or installing a payload.
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#define NOMINMAX
#include <windows.h>
#include <algorithm>
#include <cstdio>
#include <vector>

extern "C" __declspec(dllimport) HRESULT __cdecl InstallerApplyFrame(HWND window);
extern "C" __declspec(dllimport) HWND __cdecl InstallerShowProgress(HWND parent, HWND source,
    BOOL dark, UINT dpi, DWORD controlHover, DWORD controlPressed, const WCHAR* brand, const WCHAR* preparing, const WCHAR* extracting,
    const WCHAR* copying, const WCHAR* registering, const WCHAR* cleaning);
extern "C" __declspec(dllimport) BOOL __cdecl InstallerFinishProgress(HWND window);

static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    if (message == WM_DESTROY) { PostQuitMessage(0); return 0; }
    return DefWindowProcW(window, message, wparam, lparam);
}

int wmain(int argc, wchar_t** argv) {
    if (argc < 6) {
        std::fprintf(stderr, "Usage: render-test.exe <brand.bmp> <dpi> <light|dark> <hover-argb> <pressed-argb> [interactive-title]\n");
        return 1;
    }
    const int dpi = _wtoi(argv[2]);
    if (dpi < 96 || dpi > 384) return 2;
    const bool dark = wcscmp(argv[3], L"dark") == 0;
    if (!dark && wcscmp(argv[3], L"light") != 0) return 2;
    wchar_t* end = nullptr;
    const DWORD hoverArgb = wcstoul(argv[4], &end, 0);
    if (!*argv[4] || *end || (hoverArgb >> 24) != 255) return 2;
    const DWORD pressedArgb = wcstoul(argv[5], &end, 0);
    if (!*argv[5] || *end || (pressedArgb >> 24) != 255) return 2;
    const bool interactive = argc > 6;
    SetProcessDPIAware();
    WNDCLASSW type = {};
    type.lpfnWndProc = WindowProc;
    type.hInstance = GetModuleHandleW(nullptr);
    type.lpszClassName = L"HarnessInstallerRenderTest";
    type.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    if (!RegisterClassW(&type)) return 3;
    HWND window = CreateWindowW(type.lpszClassName, interactive ? argv[6] : L"Installer rendering test",
        WS_POPUP | WS_SYSMENU | WS_MINIMIZEBOX, 100, 100, MulDiv(600, dpi, 96), MulDiv(600, dpi, 96),
        nullptr, nullptr, type.hInstance, nullptr);
    if (!window || FAILED(InstallerApplyFrame(window))) return 4;
    HWND stock = CreateWindowW(L"STATIC", L"", WS_CHILD | WS_VISIBLE, 0, 0, 1, 1, window, nullptr, type.hInstance, nullptr);
    HWND source = CreateWindowW(L"STATIC", L"", WS_CHILD, 0, 0, 1, 1, stock, nullptr, type.hInstance, nullptr);
    SetPropW(window, L"HarnessInstaller.Stage", reinterpret_cast<HANDLE>(1));
    SetPropW(window, L"HarnessInstaller.ExtractProgress", reinterpret_cast<HANDLE>(50));
    const auto createProgress = [&]() {
        return InstallerShowProgress(window, source, dark, static_cast<UINT>(dpi), hoverArgb, pressedArgb, argv[1],
            L"Preparing %d%%", L"Extracting %d%%", L"Copying %d%%", L"Registering %d%%", L"Cleaning %d%%");
    };
    ShowWindow(window, SW_SHOWNOACTIVATE);
    bool clientFrame = true;
    for (int x : {8, 300, 580}) {
        POINT point{MulDiv(x, dpi, 96), MulDiv(24, dpi, 96)};
        ClientToScreen(window, &point);
        clientFrame = SendMessageW(window, WM_NCHITTEST, 0, MAKELPARAM(point.x, point.y)) == HTCLIENT && clientFrame;
    }
    HWND failed = InstallerShowProgress(window, source, dark, static_cast<UINT>(dpi), hoverArgb, pressedArgb, L"",
        L"Preparing %d%%", L"Extracting %d%%", L"Copying %d%%", L"Registering %d%%", L"Cleaning %d%%");
    ShowWindow(stock, SW_SHOW);
    const bool failurePreservesStock = !failed && IsWindowVisible(stock);
    if (failed) DestroyWindow(failed);
    // Warm retained font and window-animation resources before checking page-owned GDI objects.
    HWND warmup = createProgress();
    if (!warmup) { DestroyWindow(window); return 5; }
    UpdateWindow(warmup);
    ShowWindow(window, SW_MINIMIZE);
    ShowWindow(window, SW_RESTORE);
    UpdateWindow(warmup);
    DestroyWindow(warmup);
    const DWORD initialGdi = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
    HWND progress = createProgress();
    if (!progress) { DestroyWindow(window); return 5; }
    UpdateWindow(progress);
    if (interactive) {
        MSG message;
        BOOL result;
        while ((result = GetMessageW(&message, nullptr, 0, 0)) > 0) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
        return result == 0 ? 0 : 7;
    }
    RECT originalBounds, restoredBounds;
    GetWindowRect(window, &originalBounds);
    const auto captionPixel = [&](int x) -> COLORREF {
        // Print into a private bitmap: visible-window clipping must not affect pixel assertions.
        HDC dc = CreateCompatibleDC(nullptr);
        BITMAPINFO info = {};
        info.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
        info.bmiHeader.biWidth = MulDiv(600, dpi, 96);
        info.bmiHeader.biHeight = -MulDiv(600, dpi, 96);
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        void* pixels = nullptr;
        HBITMAP bitmap = CreateDIBSection(nullptr, &info, DIB_RGB_COLORS, &pixels, nullptr, 0);
        if (!dc || !bitmap) {
            if (dc) DeleteDC(dc);
            if (bitmap) DeleteObject(bitmap);
            return CLR_INVALID;
        }
        HGDIOBJ previous = SelectObject(dc, bitmap);
        if (!previous) { DeleteObject(bitmap); DeleteDC(dc); return CLR_INVALID; }
        SendMessageW(progress, WM_PRINTCLIENT, reinterpret_cast<WPARAM>(dc), PRF_CLIENT);
        const COLORREF pixel = GetPixel(dc, MulDiv(x + 8, dpi, 96), MulDiv(24, dpi, 96));
        SelectObject(dc, previous);
        DeleteObject(bitmap);
        DeleteDC(dc);
        return pixel;
    };
    const COLORREF normalColor = dark ? RGB(21, 21, 23) : RGB(255, 255, 255);
    const auto colorref = [](DWORD argb) { return RGB((argb >> 16) & 255, (argb >> 8) & 255, argb & 255); };
    const COLORREF hoverColor = colorref(hoverArgb);
    const COLORREF pressedColor = colorref(pressedArgb);
    const auto expectPixel = [&](int x, COLORREF expected) {
        const COLORREF actual = captionPixel(x);
        if (actual != CLR_INVALID && actual == expected) return true;
        std::fprintf(stderr, "caption pixel x=%d dpi=%d expected=0x%08lx actual=0x%08lx\n", x, dpi, expected, actual);
        return false;
    };
    bool captionStates = true;
    ShowWindow(progress, SW_HIDE);
    for (int x : {504, 548}) {
        const LPARAM point = MAKELPARAM(MulDiv(x + 20, dpi, 96), MulDiv(24, dpi, 96));
        captionStates = expectPixel(x, normalColor) && captionStates;
        SendMessageW(progress, WM_MOUSEMOVE, 0, point);
        captionStates = expectPixel(x, hoverColor) && captionStates;
        SendMessageW(progress, WM_LBUTTONDOWN, MK_LBUTTON, point);
        captionStates = expectPixel(x, pressedColor) && captionStates;
        const int other = x == 504 ? 548 : 504;
        SendMessageW(progress, WM_MOUSEMOVE, MK_LBUTTON, MAKELPARAM(MulDiv(other + 20, dpi, 96), MulDiv(24, dpi, 96)));
        captionStates = expectPixel(other, normalColor) && captionStates;
        captionStates = expectPixel(x, normalColor) && captionStates;
        SendMessageW(progress, WM_MOUSEMOVE, MK_LBUTTON, MAKELPARAM(-1, -1));
        captionStates = expectPixel(x, normalColor) && captionStates;
        SendMessageW(progress, WM_MOUSEMOVE, MK_LBUTTON, point);
        captionStates = expectPixel(x, pressedColor) && captionStates;
        SendMessageW(progress, WM_CANCELMODE, 0, 0);
        captionStates = expectPixel(x, hoverColor) && captionStates;
        SendMessageW(progress, WM_MOUSELEAVE, 0, 0);
        captionStates = expectPixel(x, normalColor) && captionStates;
    }
    ShowWindow(progress, SW_SHOW);
    const LPARAM minimizePoint = MAKELPARAM(MulDiv(524, dpi, 96), MulDiv(24, dpi, 96));
    SendMessageW(progress, WM_LBUTTONDOWN, MK_LBUTTON, minimizePoint);
    bool buttonRelease = !IsIconic(window) && GetCapture() == progress;
    SendMessageW(progress, WM_LBUTTONUP, 0, MAKELPARAM(-1, -1));
    buttonRelease = buttonRelease && !IsIconic(window) && GetCapture() != progress;
    SendMessageW(progress, WM_LBUTTONDOWN, MK_LBUTTON, minimizePoint);
    ReleaseCapture();
    SendMessageW(progress, WM_LBUTTONUP, 0, minimizePoint);
    buttonRelease = buttonRelease && !IsIconic(window);
    SendMessageW(progress, WM_LBUTTONDOWN, MK_LBUTTON, minimizePoint);
    SendMessageW(progress, WM_CANCELMODE, 0, 0);
    SendMessageW(progress, WM_LBUTTONUP, 0, minimizePoint);
    buttonRelease = buttonRelease && !IsIconic(window) && GetCapture() != progress;
    SendMessageW(progress, WM_LBUTTONDOWN, MK_LBUTTON, minimizePoint);
    SendMessageW(progress, WM_LBUTTONUP, 0, minimizePoint);
    const bool minimized = IsIconic(window) != FALSE;
    ShowWindow(window, SW_RESTORE);
    GetWindowRect(window, &restoredBounds);
    const bool restored = !IsIconic(window) && EqualRect(&originalBounds, &restoredBounds);
    const LPARAM closePoint = MAKELPARAM(MulDiv(568, dpi, 96), MulDiv(24, dpi, 96));
    MSG closeMessage;
    SendMessageW(progress, WM_LBUTTONDOWN, MK_LBUTTON, closePoint);
    bool closeRelease = !PeekMessageW(&closeMessage, window, WM_CLOSE, WM_CLOSE, PM_REMOVE);
    SendMessageW(progress, WM_LBUTTONUP, 0, minimizePoint);
    closeRelease = closeRelease && !PeekMessageW(&closeMessage, window, WM_CLOSE, WM_CLOSE, PM_REMOVE);
    SendMessageW(progress, WM_LBUTTONDOWN, MK_LBUTTON, closePoint);
    SendMessageW(progress, WM_LBUTTONUP, 0, closePoint);
    closeRelease = closeRelease && PeekMessageW(&closeMessage, window, WM_CLOSE, WM_CLOSE, PM_REMOVE);
    LARGE_INTEGER frequency, started, finished;
    QueryPerformanceFrequency(&frequency);
    std::vector<double> samples;
    // Full repaint is the exposure/restore path; fixture startup is excluded.
    constexpr int frameCount = 300;
    for (int frame = 0; frame < frameCount; ++frame) {
        InvalidateRect(progress, nullptr, FALSE);
        QueryPerformanceCounter(&started);
        UpdateWindow(progress);
        QueryPerformanceCounter(&finished);
        samples.push_back(1000.0 * (finished.QuadPart - started.QuadPart) / frequency.QuadPart);
    }
    double total = 0;
    for (double sample : samples) total += sample;
    std::printf("samples_ms=[");
    for (size_t index = 0; index < samples.size(); ++index) {
        std::printf("%s%.3f", index ? "," : "", samples[index]);
    }
    std::printf("]\n");
    std::sort(samples.begin(), samples.end());
    std::printf("fixture=standalone-progress dpi=%d dark=%d frames=%d screen=%dx%d foreground=%d mean_ms=%.3f p50_ms=%.3f p95_ms=%.3f max_ms=%.3f\n",
        dpi, dark, frameCount, GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN), GetForegroundWindow() == window,
        total / samples.size(), samples[samples.size() / 2], samples[samples.size() * 95 / 100], samples.back());
    const bool completed = InstallerFinishProgress(progress) &&
        GetPropW(window, L"HarnessInstaller.CompletedPercent") == reinterpret_cast<HANDLE>(100);
    WCHAR caption[160] = {};
    GetWindowTextW(progress, caption, ARRAYSIZE(caption));
    const bool finalCaption = wcscmp(caption, L"Extracting 100%") == 0;
    DestroyWindow(progress);
    const DWORD finalGdi = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
    DestroyWindow(window);
    std::printf("client_frame=%d stock_preserved=%d completed=%d final_caption=%d caption_states=%d button_release=%d close_release=%d minimized=%d restored=%d gdi_before=%lu gdi_after=%lu\n",
        clientFrame, failurePreservesStock, completed, finalCaption, captionStates, buttonRelease, closeRelease, minimized, restored, initialGdi, finalGdi);
    return clientFrame && failurePreservesStock && completed && finalCaption && captionStates && buttonRelease && closeRelease && minimized && restored && finalGdi <= initialGdi ? 0 : 6;
}
