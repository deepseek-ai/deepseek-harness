// Manual uninstall diagnostics and native dialogs. The NSIS caller owns one session until process exit.
#pragma once
#include <commdlg.h>
#include "uninstall-data.h"
#include "extract-report.h"

namespace uninstall_report {
struct Session {
    std::wstring text = L"DeepSeek Harness uninstall report\r\n";
    std::wstring path;
    bool issues = false;
    bool mainBlocked = false;
    uninstall_data::Handles pinned;
};
inline std::wstring Error(DWORD error) {
    WCHAR buffer[2048]{};
    FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS, nullptr, error, 0, buffer, ARRAYSIZE(buffer), nullptr);
    return std::to_wstring(error) + L" " + buffer;
}
inline void Add(Session& session, LPCWSTR operation, LPCWSTR target, DWORD error) {
    session.issues = true;
    session.text += std::wstring(L"\r\n[failed] ") + operation + L"\r\nTarget: " + target + L"\r\nWin32: " + Error(error) + L"\r\n";
}
inline void Collect(Session& session, const uninstall_data::Failures& failures) {
    for (const auto& failure : failures) Add(session, L"Remove file/directory", failure.path.c_str(), failure.error);
}
// Width is measured with the dialog font; measurement failure keeps the approved 240-DLU fallback.
inline UINT Width(HWND parent) {
    NONCLIENTMETRICSW metrics{};
    metrics.cbSize = sizeof(metrics);
    if (!SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(metrics), &metrics, 0)) return 240;
    HFONT font = parent ? reinterpret_cast<HFONT>(SendMessageW(parent, WM_GETFONT, 0, 0)) : nullptr;
    const bool owned = !font;
    if (owned) font = CreateFontIndirectW(&metrics.lfMessageFont);
    HDC dc = GetDC(parent);
    UINT width = 240;
    if (font && dc) {
        HGDIOBJ previous = SelectObject(dc, font);
        SIZE alphabet{}, characters{};
        const std::wstring sample(40, L'\x5b57');
        if (GetTextExtentPoint32W(dc, L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 52, &alphabet)
            && GetTextExtentPoint32W(dc, sample.c_str(), 40, &characters)) {
            const int base = (alphabet.cx / 26 + 1) / 2;
            if (base > 0 && characters.cx > 0) {
                width = static_cast<UINT>(MulDiv(characters.cx, 4, base) + 24);
                MONITORINFO monitor{sizeof(monitor)};
                if (GetMonitorInfoW(MonitorFromWindow(parent, MONITOR_DEFAULTTONEAREST), &monitor)) {
                    const int available = monitor.rcWork.right - monitor.rcWork.left - MulDiv(48, GetDeviceCaps(dc, LOGPIXELSX), 96);
                    if (available > 0) width = std::min(width, static_cast<UINT>(MulDiv(available, 4, base)));
                }
            }
        }
        SelectObject(dc, previous);
    }
    if (dc) ReleaseDC(parent, dc);
    if (owned && font) DeleteObject(font);
    return width;
}
inline bool Save(HWND parent, Session& session, LPCWSTR caption, LPCWSTR failed) {
    for (;;) {
        WCHAR filename[32768] = L"DeepSeek-Harness-uninstall-report.txt";
        OPENFILENAMEW picker{};
        picker.lStructSize = sizeof(picker);
        picker.hwndOwner = parent;
        picker.lpstrFilter = L"Text (*.txt)\0*.txt\0\0";
        picker.lpstrFile = filename;
        picker.nMaxFile = ARRAYSIZE(filename);
        picker.lpstrDefExt = L"txt";
        picker.lpstrTitle = caption;
        picker.Flags = OFN_OVERWRITEPROMPT | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
        if (!GetSaveFileNameW(&picker)) {
            const DWORD error = CommDlgExtendedError();
            if (!error) return false;
            Add(session, L"Open save dialog", L"report", error);
        } else if (extract_report::WriteUtf8(filename, session.text)) {
            return true;
        } else {
            Add(session, L"Save report", filename, GetLastError());
        }
        extract_report::WriteUtf8(session.path.c_str(), session.text);
        const std::wstring message = std::wstring(failed) + L"\r\n\r\n" + session.path;
        if (MessageBoxW(parent, message.c_str(), caption, MB_RETRYCANCEL | MB_ICONWARNING) != IDRETRY) return false;
    }
}
// TaskDialog elides long paths even with soft break opportunities. Insert measured line breaks;
// the report keeps the exact path, and no private TaskDialog controls are resized or subclassed.
inline std::wstring WrapPaths(HWND parent, const std::wstring& text) {
    NONCLIENTMETRICSW metrics{};
    metrics.cbSize = sizeof(metrics);
    HFONT font = nullptr;
    if (SystemParametersInfoW(SPI_GETNONCLIENTMETRICS, sizeof(metrics), &metrics, 0)) font = CreateFontIndirectW(&metrics.lfMessageFont);
    HDC dc = GetDC(parent);
    HGDIOBJ previous = font && dc ? SelectObject(dc, font) : nullptr;
    SIZE alphabet{};
    int pixels = 0;
    if (font && dc && GetTextExtentPoint32W(dc, L"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 52, &alphabet))
        pixels = MulDiv(static_cast<int>(Width(parent)) - 32, (alphabet.cx / 26 + 1) / 2, 4);
    std::wstring result;
    for (size_t start = 0; start < text.size();) {
        const size_t newline = text.find(L'\n', start);
        const size_t end = newline == std::wstring::npos ? text.size() : newline;
        const std::wstring line = text.substr(start, end - start);
        if (line.find(L":\\") == std::wstring::npos) result += line;
        else {
            for (size_t offset = 0; offset < line.size();) {
                size_t count = 0, separator = 0;
                while (offset + count < line.size()) {
                    SIZE size{};
                    const bool measured = pixels > 0 && GetTextExtentPoint32W(dc, line.c_str() + offset, static_cast<int>(count + 1), &size);
                    if (count && (measured ? size.cx > pixels : count >= 24)) break;
                    if (line[offset + count] == L'\\') separator = count + 1;
                    ++count;
                }
                if (offset + count < line.size() && separator) count = separator;
                if (count > 1 && offset + count < line.size() && IS_HIGH_SURROGATE(line[offset + count - 1])) --count;
                result.append(line, offset, count);
                offset += count;
                if (offset < line.size()) result += L"\r\n";
            }
        }
        if (newline != std::wstring::npos) result += L'\n';
        start = end + 1;
    }
    if (previous) SelectObject(dc, previous);
    if (dc) ReleaseDC(parent, dc);
    if (font) DeleteObject(font);
    return result;
}
// mode 1 confirms old-directory cleanup; mode 2 allows retry; other modes only close/save.
inline int Show(HWND parent, Session& session, int mode, LPCWSTR title, LPCWSTR heading,
    LPCWSTR body, LPCWSTR primary, LPCWSTR save, LPCWSTR failed) {
    const bool persisted = extract_report::WriteUtf8(session.path.c_str(), session.text);
    const std::wstring content = WrapPaths(parent, std::wstring(body) + (mode != 1 && persisted ? L"\r\n\r\n" + session.path : L""));
    using TaskDialogFn = HRESULT(WINAPI*)(const TASKDIALOGCONFIG*, int*, int*, BOOL*);
    HMODULE library = LoadLibraryW(L"comctl32.dll");
    auto dialog = library ? reinterpret_cast<TaskDialogFn>(GetProcAddress(library, "TaskDialogIndirect")) : nullptr;
    int pressed = IDCANCEL;
    for (;;) {
        TASKDIALOG_BUTTON buttons[] = {{1001, primary}, {1002, save}};
        TASKDIALOGCONFIG config{};
        config.cbSize = sizeof(config);
        config.hwndParent = parent;
        config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
        config.dwCommonButtons = mode == 1 ? TDCBF_CANCEL_BUTTON : TDCBF_CLOSE_BUTTON;
        if (mode == 2) config.dwCommonButtons |= TDCBF_RETRY_BUTTON;
        config.pszWindowTitle = title;
        config.pszMainInstruction = heading;
        config.pszContent = content.c_str();
        config.cButtons = 1;
        config.pButtons = mode == 1 ? buttons : buttons + 1;
        config.nDefaultButton = mode == 1 ? IDCANCEL : IDCLOSE;
        config.cxWidth = Width(parent);
        const HRESULT result = dialog ? dialog(&config, &pressed, nullptr, nullptr) : E_NOTIMPL;
        if (FAILED(result)) {
            // Failing to create confirmation UI must never grant deletion permission.
            if (mode == 1) { MessageBoxW(parent, body, heading, MB_OK | MB_ICONWARNING); pressed = IDCANCEL; }
            else {
                pressed = MessageBoxW(parent, content.c_str(), heading, mode == 2 ? MB_RETRYCANCEL : MB_OK);
                if (pressed != IDRETRY && MessageBoxW(parent, save, title, MB_YESNO | MB_DEFBUTTON2) == IDYES)
                    Save(parent, session, save, failed);
            }
            break;
        }
        if (pressed != 1002) break;
        Save(parent, session, save, failed);
    }
    if (library) FreeLibrary(library);
    return pressed;
}

// Pin every ancestor and reject shell roots/ancestors before any payload removal.
inline DWORD Prepare(Session& session, LPCWSTR directory, LPCWSTR protectedRoot, bool& homeFailure) {
    std::wstring path;
    if (!uninstall_data::Normalize(directory, path)) return ERROR_INVALID_NAME;
    if (protectedRoot && *protectedRoot) {
        homeFailure = true;
        std::wstring home;
        if (!uninstall_data::NormalizeHome(protectedRoot, home)) return ERROR_INVALID_NAME;
        if (uninstall_data::Contains(path, home) || uninstall_data::Contains(home, path)) return ERROR_ACCESS_DENIED;
        homeFailure = false;
    }
    const KNOWNFOLDERID* folders[] = {&FOLDERID_Profile, &FOLDERID_RoamingAppData, &FOLDERID_LocalAppData,
        &FOLDERID_Desktop, &FOLDERID_Documents, &FOLDERID_Downloads, &FOLDERID_Pictures, &FOLDERID_Music,
        &FOLDERID_Videos, &FOLDERID_Public, &FOLDERID_ProgramData, &FOLDERID_Windows, &FOLDERID_ProgramFiles, &FOLDERID_ProgramFilesX86};
    WCHAR nativePrograms[32768];
    DWORD bytes = sizeof(nativePrograms);
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion", L"ProgramFilesDir",
        RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, nullptr, nativePrograms, &bytes) != ERROR_SUCCESS) return ERROR_ACCESS_DENIED;
    if (uninstall_data::Contains(path, nativePrograms)) return ERROR_ACCESS_DENIED;
    for (const auto* id : folders) {
        PWSTR value = nullptr;
        const HRESULT result = SHGetKnownFolderPath(*id, KF_FLAG_DONT_VERIFY, nullptr, &value);
        if (FAILED(result)) return ERROR_ACCESS_DENIED;
        const bool unsafe = uninstall_data::Contains(path, value)
            || (id == &FOLDERID_Windows && uninstall_data::Contains(value, path));
        CoTaskMemFree(value);
        if (unsafe) return ERROR_ACCESS_DENIED;
    }
    for (size_t end = path.find(L'\\', 3);; end = path.find(L'\\', end + 1)) {
        const DWORD error = uninstall_data::Pin(end == std::wstring::npos ? path : path.substr(0, end), session.pinned);
        if (error) return error;
        if (end == std::wstring::npos) break;
    }
    return ERROR_SUCCESS;
}
// The executable goes first. A failure leaves every other file, including the retry uninstaller, in place.
inline DWORD Payload(Session& session, LPCWSTR directory, LPCWSTR executable, LPCWSTR uninstaller) {
    if (session.mainBlocked) {
        session.text += L"\r\nRetrying main executable removal; preceding failure is historical.\r\n";
        session.issues = false;
        session.mainBlocked = false;
    }
    const std::wstring main = std::wstring(directory) + L"\\" + executable;
    const DWORD attributes = GetFileAttributesW((L"\\\\?\\" + main).c_str());
    DWORD error = ERROR_SUCCESS;
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND) error = ERROR_SUCCESS;
    } else if (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) error = ERROR_ACCESS_DENIED;
    else error = uninstall_data::Unlink(L"\\\\?\\" + main, attributes);
    if (error) { session.mainBlocked = true; Add(session, L"Remove main executable; remaining cleanup not executed", main.c_str(), error); return error; }
    WIN32_FIND_DATAW entry{};
    HANDLE search = FindFirstFileW((std::wstring(L"\\\\?\\") + directory + L"\\*").c_str(), &entry);
    if (search == INVALID_HANDLE_VALUE) { error = GetLastError(); Add(session, L"Enumerate payload; result incomplete", directory, error); return error; }
    uninstall_data::Failures failures;
    do {
        if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0 || _wcsicmp(entry.cFileName, uninstaller) == 0) continue;
        uninstall_data::RemoveTree(std::wstring(directory) + L"\\" + entry.cFileName, &failures);
    } while (FindNextFileW(search, &entry));
    error = GetLastError();
    FindClose(search);
    Collect(session, failures);
    if (error != ERROR_NO_MORE_FILES) { Add(session, L"Enumerate payload; result incomplete", directory, error); return error; }
    return ERROR_SUCCESS;
}
}

extern "C" __declspec(dllexport) uninstall_report::Session* __cdecl UninstallBegin(LPCWSTR path) {
    // Session storage and callbacks must outlive System plug-in calls.
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_PIN | GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS,
        reinterpret_cast<LPCWSTR>(&UninstallBegin), &module)) return nullptr;
    auto* session = new (std::nothrow) uninstall_report::Session;
    if (session) session->path = path;
    return session;
}
extern "C" __declspec(dllexport) DWORD __cdecl UninstallPrepare(uninstall_report::Session* session, LPCWSTR path, LPCWSTR home) {
    bool homeFailure = false;
    const DWORD error = uninstall_report::Prepare(*session, path, home, homeFailure);
    if (error) uninstall_report::Add(*session, homeFailure ? L"Validate DSH_HOME; no deletion started" : L"Validate removal scope; no deletion started", homeFailure ? home : path, error);
    return error;
}
extern "C" __declspec(dllexport) DWORD __cdecl UninstallPayload(uninstall_report::Session* session, LPCWSTR path, LPCWSTR executable, LPCWSTR uninstaller) {
    const DWORD error = uninstall_report::Payload(*session, path, executable, uninstaller);
    return !error ? 0 : session->mainBlocked ? 1 : 2;
}
extern "C" __declspec(dllexport) void __cdecl UninstallData(uninstall_report::Session* session, LPCWSTR path, LPCWSTR installation, LPCWSTR home) {
    uninstall_data::Failures failures;
    const DWORD error = uninstall_data::Remove(path, installation, home, &failures);
    if (error && failures.empty()) uninstall_report::Add(*session, L"Remove data directory", path, error);
    uninstall_report::Collect(*session, failures);
}
extern "C" __declspec(dllexport) void __cdecl UninstallNote(uninstall_report::Session* session, LPCWSTR text) {
    session->issues = true;
    session->text += std::wstring(L"\r\n") + text + L"\r\n";
}
extern "C" __declspec(dllexport) int __cdecl UninstallShow(uninstall_report::Session* session, HWND parent, int mode,
    LPCWSTR title, LPCWSTR heading, LPCWSTR body, LPCWSTR primary, LPCWSTR save, LPCWSTR failed) {
    return uninstall_report::Show(parent, *session, mode, title, heading, body, primary, save, failed);
}
extern "C" __declspec(dllexport) int __cdecl UninstallFinish(uninstall_report::Session* session, LPCWSTR directory, LPCWSTR uninstaller) {
    const std::wstring file = std::wstring(directory) + L"\\" + uninstaller;
    const DWORD attributes = GetFileAttributesW((L"\\\\?\\" + file).c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES) {
        const DWORD error = uninstall_data::Unlink(L"\\\\?\\" + file, attributes);
        if (error) uninstall_report::Add(*session, L"Remove uninstaller", file.c_str(), error);
    } else {
        const DWORD error = GetLastError();
        if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND)
            uninstall_report::Add(*session, L"Inspect uninstaller", file.c_str(), error);
    }
    for (HANDLE handle : session->pinned.values) CloseHandle(handle);
    session->pinned.values.clear();
    if (!RemoveDirectoryW((std::wstring(L"\\\\?\\") + directory).c_str())) {
        const DWORD error = GetLastError();
        if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) uninstall_report::Add(*session, L"Remove installation directory", directory, error);
    }
    session->text += L"\r\nPayload removal completed. Failed or unverified items are listed above.\r\n";
    if (session->issues || GetFileAttributesW(session->path.c_str()) != INVALID_FILE_ATTRIBUTES) extract_report::WriteUtf8(session->path.c_str(), session->text);
    return session->issues ? 1 : 0;
}
extern "C" __declspec(dllexport) void __cdecl UninstallPersist(uninstall_report::Session* session) {
    extract_report::WriteUtf8(session->path.c_str(), session->text);
}
extern "C" __declspec(dllexport) void __cdecl UninstallImport(uninstall_report::Session* session, LPCWSTR path) {
    const std::wstring report = extract_report::ReadOutput(path);
    if (!report.empty()) { session->issues = true; session->text += L"\r\n" + report; }
}

extern "C" __declspec(dllexport) int __cdecl UninstallShowOwner(uninstall_report::Session* session, HWND parent,
    LPCWSTR title, LPCWSTR heading, LPCWSTR registered, LPCWSTR directory, LPCWSTR registeredLabel,
    LPCWSTR scopeLabel, LPCWSTR primary, LPCWSTR save, LPCWSTR failed) {
    const std::wstring body = std::wstring(registeredLabel) + L"\r\n" + registered + L"\r\n\r\n"
        + scopeLabel + L"\r\n" + directory;
    return uninstall_report::Show(parent, *session, 1, title, heading, body.c_str(), primary, save, failed);
}
