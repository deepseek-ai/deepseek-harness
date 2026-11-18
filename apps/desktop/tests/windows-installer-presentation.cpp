#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>

extern "C" __declspec(dllimport) BOOL __cdecl InstallerPresentWelcome(HWND window);

static bool Above(HWND upper, HWND lower) {
    for (HWND current = GetWindow(lower, GW_HWNDPREV); current;
         current = GetWindow(current, GW_HWNDPREV)) {
        if (current == upper) return true;
    }
    return false;
}

int wmain() {
    HINSTANCE instance = GetModuleHandleW(nullptr);
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
