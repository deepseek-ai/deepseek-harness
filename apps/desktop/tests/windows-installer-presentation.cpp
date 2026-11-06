#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>
#include <cstdio>

extern "C" __declspec(dllimport) BOOL __cdecl InstallerPresentWelcome(HWND window);
extern "C" __declspec(dllimport) HRESULT __cdecl InstallerApplyFrame(HWND window);

// NSIS ui.h and installer/pages.nsh define this outer-page notification.
constexpr UINT WM_NOTIFY_OUTER_NEXT = WM_USER + 8;

struct MoveTest {
    bool moving = false;
    bool reentered = false;
    bool destroyDuringMove = false;
    bool native = false;
    bool entered = false;
    bool captionEntry = false;

    unsigned transitions = 0;
};

static void Drain(HWND window) {
    MSG message;
    while (PeekMessageW(&message, window, 0, 0, PM_REMOVE)) DispatchMessageW(&message);
}

static LRESULT CALLBACK MoveProc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    auto* test = reinterpret_cast<MoveTest*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    if (message == WM_CREATE) {
        test = static_cast<MoveTest*>(reinterpret_cast<CREATESTRUCTW*>(lparam)->lpCreateParams);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(test));
    }
    if (test && message == WM_NOTIFY_OUTER_NEXT) {
        ++test->transitions;
        test->reentered = test->reentered || test->moving;
        return 0;
    }
    if (test && test->native && (message == WM_ENTERSIZEMOVE || message == WM_ENTERMENULOOP)) {
        test->entered = true;
        PostMessageW(window, WM_APP, 0, 0);
    }
    if (test && test->native && message == WM_APP) {
        SendMessageW(window, WM_NOTIFY_OUTER_NEXT, 1, 0);
        if (test->captionEntry) {
            INPUT release = {}; release.type = INPUT_MOUSE; release.mi.dwFlags = MOUSEEVENTF_LEFTUP;
            SendInput(1, &release, sizeof(release));
        }
        SendMessageW(window, WM_CANCELMODE, 0, 0);
        return 0;
    }
    if (test && message == WM_SYSCOMMAND && ((wparam & 0xfff0) == SC_MOVE || (wparam & 0xfff0) == SC_KEYMENU || (wparam & 0xfff0) == SC_MOUSEMENU)) {
        if (test->native) {
            test->moving = true;
            const LRESULT result = DefWindowProcW(window, message, wparam, lparam);
            test->moving = false;
            return result;
        }
        // Model a native nested loop, including pumping after WM_EXITSIZEMOVE:
        // that notification alone is not evidence that the move call returned.
        test->moving = true;
        SendMessageW(window, WM_ENTERSIZEMOVE, 0, 0);
        SendMessageW(window, WM_NOTIFY_OUTER_NEXT, 1, 0);
        Drain(window);
        SendMessageW(window, WM_EXITSIZEMOVE, 0, 0);
        Drain(window);
        if (test->destroyDuringMove) DestroyWindow(window);
        test->moving = false;
        return 0;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

static bool TestMoveCompletion(HINSTANCE instance, bool destroy, bool native = false, bool captionEntry = false, UINT menu = 0) {
    MoveTest test;
    test.destroyDuringMove = destroy;
    test.native = native;
    test.captionEntry = captionEntry;

    HWND window = CreateWindowExW(0, L"HarnessInstallerMoveTest", L"", WS_POPUP | WS_SYSMENU | WS_MINIMIZEBOX,
        0, 0, 100, 100, nullptr, nullptr, instance, &test);
    if (!window) return false;
    if (FAILED(InstallerApplyFrame(window))) { DestroyWindow(window); return false; }
    RECT clipBefore, clipAfter;
    GetClipCursor(&clipBefore);
    if (native) ShowWindow(window, SW_SHOWNOACTIVATE);
    if (menu) SetForegroundWindow(window);
    POINT cursorBefore;
    GetCursorPos(&cursorBefore);
    if (captionEntry) {
        SetForegroundWindow(window);
        SetCursorPos(50, 24);
        INPUT press = {}; press.type = INPUT_MOUSE; press.mi.dwFlags = MOUSEEVENTF_LEFTDOWN;
        const UINT sent = SendInput(1, &press, sizeof(press));
        if (sent != 1) { DestroyWindow(window); SetCursorPos(cursorBefore.x, cursorBefore.y); return false; }
        const ULONGLONG deadline = GetTickCount64() + 2000;
        while (!(GetAsyncKeyState(VK_LBUTTON) & 0x8000) && GetTickCount64() < deadline) {
            Drain(window);
            MsgWaitForMultipleObjectsEx(0, nullptr, 10, QS_ALLINPUT, MWMO_INPUTAVAILABLE);
        }
        Drain(window);

        SendMessageW(window, WM_NCLBUTTONDOWN, HTCAPTION, MAKELPARAM(50, 24));
        INPUT release = {}; release.type = INPUT_MOUSE; release.mi.dwFlags = MOUSEEVENTF_LEFTUP;
        SendInput(1, &release, sizeof(release));
    } else {
        SendMessageW(window, WM_SYSCOMMAND, menu ? menu : native ? SC_MOVE : SC_MOVE | 2, menu == SC_KEYMENU ? VK_SPACE : 0);
    }
    SetCursorPos(cursorBefore.x, cursorBefore.y);
    const bool deferred = test.transitions == 0 && !test.reentered;
    if (destroy) return deferred && !IsWindow(window);
    Drain(window);
    const bool delivered = test.transitions == 1 && !test.reentered;
    SendMessageW(window, WM_NOTIFY_OUTER_NEXT, 1, 0);
    const bool ordinary = test.transitions == 2;
    GetClipCursor(&clipAfter);
    GUITHREADINFO input = {sizeof(input)};
    const bool released = GetGUIThreadInfo(GetCurrentThreadId(), &input)
        && !input.hwndCapture && !input.hwndMoveSize && EqualRect(&clipBefore, &clipAfter);
    std::printf("native=%d deferred=%d delivered=%d ordinary=%d entered=%d released=%d capture=%p move=%p\n",
        native, deferred, delivered, ordinary, test.entered, released, input.hwndCapture, input.hwndMoveSize);
    DestroyWindow(window);
    return deferred && delivered && ordinary && (!native || (test.entered && released));
}

static bool Above(HWND upper, HWND lower) {
    for (HWND current = GetWindow(lower, GW_HWNDPREV); current;
         current = GetWindow(current, GW_HWNDPREV)) {
        if (current == upper) return true;
    }
    return false;
}

int wmain() {
    HINSTANCE instance = GetModuleHandleW(nullptr);
    WNDCLASSW type = {};
    type.hInstance = instance;
    type.lpfnWndProc = MoveProc;
    type.lpszClassName = L"HarnessInstallerMoveTest";
    if (!RegisterClassW(&type)) return 7;
    if (!TestMoveCompletion(instance, false) || !TestMoveCompletion(instance, true)) return 8;
    if (!TestMoveCompletion(instance, false, true)) return 9;
    if (!TestMoveCompletion(instance, false, true, true)) return 10;
    if (!TestMoveCompletion(instance, false, true, false, SC_KEYMENU)) return 11;
    if (!TestMoveCompletion(instance, false, true, false, SC_MOUSEMENU)) return 12;
    std::puts("Move completion deferred until native call returns; destruction discards pending transition.");
    HWND installer = CreateWindowExW(0, L"STATIC", L"Installer", WS_POPUP,
                                     100, 100, 300, 300, nullptr, nullptr, instance, nullptr);
    HWND other = CreateWindowExW(0, L"STATIC", L"Other", WS_POPUP,
                                 120, 120, 300, 300, nullptr, nullptr, instance, nullptr);
    if (!installer || !other) return 1;
    ShowWindow(installer, SW_SHOW);
    ShowWindow(other, SW_SHOW);
    if (!Above(other, installer)) return 2;
    if (!InstallerPresentWelcome(installer)) return 3;
    if (!Above(installer, other)) return 4;
    if (GetWindowLongPtrW(installer, GWL_EXSTYLE) & WS_EX_TOPMOST) return 5;
    if (GetPropW(installer, L"HarnessInstaller.Presented") != reinterpret_cast<HANDLE>(1)) return 6;
    DestroyWindow(other);
    DestroyWindow(installer);
    return 0;
}
