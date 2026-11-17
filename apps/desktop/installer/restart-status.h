#pragma once
#include <shellapi.h>
#include <memory>
#include <string>
#include "restart-banner.h"

namespace restart_status {
struct Launch {
    std::wstring command;
    std::wstring program;
    std::wstring directory;
    HANDLE job;
};

// Process creation can involve security software. The installer never joins this thread.
static DWORD WINAPI LaunchWorker(void* data) {
    std::unique_ptr<Launch> launch(static_cast<Launch*>(data));
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SIZE_T bytes = 0;
    InitializeProcThreadAttributeList(nullptr, 1, 0, &bytes);
    auto* attributes = static_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(HeapAlloc(GetProcessHeap(), 0, bytes));
    bool started = false;
    if (attributes && SetInformationJobObject(launch->job, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) &&
            InitializeProcThreadAttributeList(attributes, 1, 0, &bytes)) {
        if (UpdateProcThreadAttribute(attributes, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &launch->job, sizeof(HANDLE), nullptr, nullptr)) {
            STARTUPINFOEXW startup{};
            startup.StartupInfo.cb = sizeof(startup);
            startup.lpAttributeList = attributes;
            PROCESS_INFORMATION process{};
            started = CreateProcessW(launch->program.c_str(), &launch->command[0], nullptr, nullptr, FALSE,
                EXTENDED_STARTUPINFO_PRESENT, nullptr, launch->directory.c_str(), &startup.StartupInfo, &process) != FALSE;
            if (started) {
                CloseHandle(process.hThread);
                CloseHandle(process.hProcess);
            }
        }
        DeleteProcThreadAttributeList(attributes);
    }
    if (attributes) HeapFree(GetProcessHeap(), 0, attributes);
    CloseHandle(launch->job);
    return 0;
}

static INT_PTR CALLBACK Dialog(HWND window, UINT message, WPARAM, LPARAM) {
    if (message == WM_CLOSE) { DestroyWindow(window); return TRUE; }
    if (message == WM_DESTROY) { PostQuitMessage(0); return TRUE; }
    return FALSE;
}
}

// The shell host is a member of a private job from its first instruction. Parent exit
// terminates even a stuck window, without a child-to-installer IPC or acknowledgment.
extern "C" __declspec(dllexport) HANDLE __cdecl InstallerStartRestartStatus(LPCWSTR installer, LPCWSTR theme,
        int language, LPCWSTR text) noexcept {
    try {
        HMODULE module{};
        if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
                reinterpret_cast<LPCWSTR>(&restart_status::LaunchWorker), &module)) return nullptr;
        wchar_t dll[MAX_PATH]{}, system[MAX_PATH]{};
        const DWORD length = GetModuleFileNameW(module, dll, ARRAYSIZE(dll));
        const UINT sysLength = GetSystemDirectoryW(system, ARRAYSIZE(system));
        if (!length || length >= ARRAYSIZE(dll) || !sysLength || sysLength >= ARRAYSIZE(system)) return nullptr;
        auto launch = std::make_unique<restart_status::Launch>();
        // An inherited installation directory would prevent its rename while the status window is alive.
        launch->directory = system;
        launch->program = std::wstring(system) + L"\\rundll32.exe";
        launch->command = L"\"" + launch->program + L"\" \"" + dll + L"\",ShowRestartStatus \"" +
            installer + L"\" " + std::to_wstring(language) + L" " + theme + L" " + text;
        HANDLE owner = CreateJobObjectW(nullptr, nullptr);
        if (!owner) return nullptr;
        if (!DuplicateHandle(GetCurrentProcess(), owner, GetCurrentProcess(), &launch->job, 0, FALSE, DUPLICATE_SAME_ACCESS)) {
            CloseHandle(owner);
            return nullptr;
        }
        auto* args = launch.release();
        HANDLE thread = CreateThread(nullptr, 0, restart_status::LaunchWorker, args, 0, nullptr);
        if (thread) {
            CloseHandle(thread);
            return owner;
        }
        CloseHandle(owner);
        CloseHandle(args->job);
        delete args;
    } catch (const std::bad_alloc&) {
        // A missing status window does not change the installation.
    }
    return nullptr;
}

#if defined(_M_IX86)
#pragma comment(linker, "/EXPORT:ShowRestartStatusW=_ShowRestartStatusW@16")
#else
#pragma comment(linker, "/EXPORT:ShowRestartStatusW")
#endif
extern "C" void CALLBACK ShowRestartStatusW(HWND, HINSTANCE instance, LPWSTR raw, int) {
    SetErrorMode(SEM_FAILCRITICALERRORS | SEM_NOGPFAULTERRORBOX | SEM_NOOPENFILEERRORBOX);
    if (!raw || *raw != L'"') return;
    wchar_t* end = wcschr(raw + 1, L'"');
    if (!end || end[1] != L' ') return;
    *end = 0;
    const wchar_t* installer = raw + 1;
    wchar_t* theme{};
    const long language = wcstol(end + 2, &theme, 10);
    if (*theme != L' ') return;
    wchar_t* text = wcschr(++theme, L' ');
    if (!text) return;
    *text++ = 0;
    const bool dark = wcscmp(theme, L"dark") == 0;
    wchar_t locale[LOCALE_NAME_MAX_LENGTH]{};
    LCIDToLocaleName(MAKELCID(language, SORT_DEFAULT), locale, ARRAYSIZE(locale), 0);
#pragma warning(push)
#pragma warning(disable: 4191)
    const auto setDpi = reinterpret_cast<decltype(&SetThreadDpiAwarenessContext)>(
        GetProcAddress(GetModuleHandleW(L"user32.dll"), "SetThreadDpiAwarenessContext"));
#pragma warning(pop)
    if (setDpi) setDpi(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    struct { DLGTEMPLATE dialog; WORD menu, cls, title; } layout{};
    layout.dialog.style = WS_POPUP | DS_CENTER | DS_MODALFRAME;
    layout.dialog.dwExtendedStyle = WS_EX_APPWINDOW;
    layout.dialog.cx = 180;
    layout.dialog.cy = 50;
    HWND window = CreateDialogIndirectParamW(instance, &layout.dialog, nullptr, restart_status::Dialog, 0);
    if (!window) return;
    SetWindowTextW(window, L"DeepSeek Harness");
    const DWORD style = WS_CHILD | WS_VISIBLE;
    HWND image = CreateWindowW(L"STATIC", L"", style | SS_ICON, 0,0,0,0, window,
        reinterpret_cast<HMENU>(restart_banner::iconId), instance, nullptr);
    HWND title = CreateWindowW(L"STATIC", L"", style, 0,0,0,0, window, reinterpret_cast<HMENU>(restart_banner::titleId), instance, nullptr);
    HWND label = CreateWindowW(L"STATIC", text, style, 0,0,0,0, window, reinterpret_cast<HMENU>(restart_banner::bodyId), instance, nullptr);
    if (!image || !title || !label) { DestroyWindow(window); return; }
    HICON large{}, smallIcon{};
    ExtractIconExW(installer, 0, &large, &smallIcon, 1);
    SendMessageW(image, STM_SETICON, reinterpret_cast<WPARAM>(large), 0);
    SendMessageW(window, WM_SETICON, ICON_BIG, reinterpret_cast<LPARAM>(large));
    SendMessageW(window, WM_SETICON, ICON_SMALL, reinterpret_cast<LPARAM>(smallIcon));
    InstallerStyleRestartBanner(window, text, locale, L"Microsoft YaHei UI", 14,
        dark ? RGB(21,21,23) : RGB(255,255,255), dark ? RGB(255,255,255) : RGB(15,17,21));
    if (GetPropW(window, restart_banner::stateKey)) {
        ShowWindow(window, SW_SHOWNOACTIVATE);
        MSG message{};
        while (GetMessageW(&message, nullptr, 0, 0) > 0) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
    if (IsWindow(window)) DestroyWindow(window);
    DestroyIcon(large);
    DestroyIcon(smallIcon);
}
