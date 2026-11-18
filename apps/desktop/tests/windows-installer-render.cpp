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
extern "C" __declspec(dllimport) BOOL __cdecl InstallerFinishProgress(HWND window, const WCHAR* finish, const WCHAR* launch);
extern "C" __declspec(dllimport) int __cdecl InstallerTakeFinishChoice(HWND window);

struct CompletionProbe {
    HWND progress;
    ULONGLONG deadline;
    RECT bounds;
    bool requested = false;
    bool completedDuringMove = false;
};

static void PollCompletion(HWND window, CompletionProbe& probe) {
    const HWND finish = FindWindowExW(probe.progress, nullptr, L"Button", L"Finish");
    const HWND launch = FindWindowExW(probe.progress, nullptr, L"Button", L"Launch");
    if (finish && launch && IsWindowVisible(finish) && IsWindowVisible(launch)) {
        GUITHREADINFO input{sizeof(input)};
        RECT current;
        probe.completedDuringMove = GetGUIThreadInfo(GetCurrentThreadId(), &input)
            && input.hwndMoveSize == window && GetWindowRect(window, &current)
            && EqualRect(&current, &probe.bounds) && IsWindowEnabled(finish)
            && SendMessageW(launch, BM_GETCHECK, 0, 0) == BST_CHECKED
            && GetPropW(window, L"HarnessInstaller.CompletedPercent") == reinterpret_cast<HANDLE>(100);
    } else if (GetTickCount64() < probe.deadline) {
        return;
    }
    SendMessageW(window, WM_CANCELMODE, 0, 0);
}

static bool CompleteWhileMinimized(HWND window, HWND progress) {
    ShowWindow(window, SW_MINIMIZE);
    const HWND foreground = GetForegroundWindow();
    if (!IsIconic(window) || !InstallerFinishProgress(progress, L"Finish", L"Launch")) return false;
    const ULONGLONG deadline = GetTickCount64() + 5000;
    while (GetTickCount64() < deadline) {
        const HWND finish = FindWindowExW(progress, nullptr, L"Button", L"Finish");
        if (finish && IsWindowVisible(finish)) {
            return IsIconic(window) && (foreground == window || GetForegroundWindow() != window)
                && GetPropW(window, L"HarnessInstaller.Succeeded") != nullptr;
        }
        MSG message;
        while (PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
        MsgWaitForMultipleObjectsEx(0, nullptr, 16, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
    }
    return false;
}

static LRESULT CALLBACK WindowProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* probe = reinterpret_cast<CompletionProbe*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (probe && message == WM_ENTERSIZEMOVE) {
        GetWindowRect(window, &probe->bounds);
        PostMessageW(window, WM_APP, 0, 0);
    }
    if (probe && message == WM_APP) {
        probe->requested = InstallerFinishProgress(probe->progress, L"Finish", L"Launch") != FALSE;
        if (!probe->requested || !SetTimer(window, 1, 16, nullptr)) SendMessageW(window, WM_CANCELMODE, 0, 0);
        return 0;
    }
    if (probe && message == WM_TIMER && wparam == 1) {
        PollCompletion(window, *probe);
        return 0;
    }
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
    const bool minimizedCompletion = CompleteWhileMinimized(window, warmup);
    ShowWindow(window, SW_RESTORE);
    UpdateWindow(warmup);
    DestroyWindow(warmup);
    RemovePropW(window, L"HarnessInstaller.CompletedPercent");
    RemovePropW(window, L"HarnessInstaller.Succeeded");
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
    {
        constexpr int x = 504;
        const LPARAM point = MAKELPARAM(MulDiv(x + 20, dpi, 96), MulDiv(24, dpi, 96));
        captionStates = expectPixel(x, normalColor) && captionStates;
        SendMessageW(progress, WM_MOUSEMOVE, 0, point);
        captionStates = expectPixel(x, hoverColor) && captionStates;
        SendMessageW(progress, WM_LBUTTONDOWN, MK_LBUTTON, point);
        captionStates = expectPixel(x, pressedColor) && captionStates;
        constexpr int other = 548;
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
    bool closeDisabled = GetCapture() != progress && expectPixel(548, normalColor)
        && !PeekMessageW(&closeMessage, window, WM_CLOSE, WM_CLOSE, PM_REMOVE);
    SendMessageW(progress, WM_MOUSEMOVE, MK_LBUTTON, closePoint);
    closeDisabled = closeDisabled && expectPixel(548, normalColor);
    SendMessageW(progress, WM_LBUTTONUP, 0, minimizePoint);
    closeDisabled = closeDisabled && !PeekMessageW(&closeMessage, window, WM_CLOSE, WM_CLOSE, PM_REMOVE);
    SendMessageW(progress, WM_LBUTTONDOWN, MK_LBUTTON, closePoint);
    SendMessageW(progress, WM_LBUTTONUP, 0, closePoint);
    closeDisabled = closeDisabled && !PeekMessageW(&closeMessage, window, WM_CLOSE, WM_CLOSE, PM_REMOVE) && GetCapture() != progress;
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
    CompletionProbe probe{progress, GetTickCount64() + 5000, {}};
    POINT originalCursor{};
    const bool restoreCursor = GetCursorPos(&originalCursor) != FALSE;
    SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(&probe));
    SendMessageW(window, WM_SYSCOMMAND, SC_MOVE, 0);
    if (restoreCursor) SetCursorPos(originalCursor.x, originalCursor.y);
    KillTimer(window, 1);
    SetWindowLongPtrW(window, GWLP_USERDATA, 0);
    const bool completed = probe.requested && probe.completedDuringMove;
    bool finishActions = completed && InstallerTakeFinishChoice(progress) == -1;
    bool finishInTabOrder = false, launchInTabOrder = false;
    if (finishActions) {
        const HWND finish = FindWindowExW(progress, nullptr, L"Button", L"Finish");
        const HWND launch = FindWindowExW(progress, nullptr, L"Button", L"Launch");
        const HWND close = FindWindowExW(progress, nullptr, L"Button", L"\x00d7");
        const HWND first = GetNextDlgTabItem(window, nullptr, FALSE);
        HWND tab = first;
        for (int next = 0; tab && next < 4; ++next) {
            finishInTabOrder |= tab == finish;
            launchInTabOrder |= tab == launch;
            tab = GetNextDlgTabItem(window, tab, FALSE);
            if (tab == first) break;
        }
        SendMessageW(finish, BM_CLICK, 0, 0);
        finishActions = InstallerTakeFinishChoice(progress) == 1 && InstallerTakeFinishChoice(progress) == -1;
        SendMessageW(close, BM_CLICK, 0, 0);
        finishActions = finishActions && InstallerTakeFinishChoice(progress) == 0;
        SendMessageW(launch, BM_CLICK, 0, 0);
        SendMessageW(window, WM_COMMAND, MAKEWPARAM(IDOK, BN_CLICKED), 0);
        finishActions = finishActions && InstallerTakeFinishChoice(progress) == 0;
    }
    DestroyWindow(progress);
    const DWORD finalGdi = GetGuiResources(GetCurrentProcess(), GR_GDIOBJECTS);
    DestroyWindow(window);
    std::printf("client_frame=%d stock_preserved=%d completed_during_move=%d caption_states=%d button_release=%d close_disabled=%d minimized=%d restored=%d gdi_before=%lu gdi_after=%lu\n",
        clientFrame, failurePreservesStock, completed, captionStates, buttonRelease, closeDisabled, minimized, restored, initialGdi, finalGdi);
    std::printf("minimized_completion=%d finish_actions=%d finish_tab=%d launch_tab=%d\n",
        minimizedCompletion, finishActions, finishInTabOrder, launchInTabOrder);
    return clientFrame && failurePreservesStock && completed && minimizedCompletion && finishActions
        && finishInTabOrder && launchInTabOrder && captionStates && buttonRelease && closeDisabled
        && minimized && restored && finalGdi <= initialGdi ? 0 : 6;
}
