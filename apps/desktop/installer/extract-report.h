// 7-Zip's error output is the primary evidence for an extraction failure; the report preserves it verbatim
// on disk and in the clipboard while the dialog shows only a headline and a bounded excerpt.
#pragma once
#include <windows.h>
#include <commctrl.h>
#include <shlobj.h>
#include <algorithm>
#include <string>
#include <vector>

namespace extract_report {

constexpr size_t kOutputLimit = 16 * 1024 * 1024;
constexpr size_t kHeadlineLimit = 160;
constexpr size_t kExcerptLineLimit = 120;
constexpr size_t kExcerptLines = 10;
constexpr size_t kExcerptChars = 1000;
constexpr wchar_t kEllipsis = 0x2026;
constexpr wchar_t kOutputMarker[] = L"7-Zip output:";

// Exit codes documented by 7-Zip; the installer treats every non-zero value as fatal.
inline const wchar_t* SevenZipMeaning(int code) {
    switch (code) {
        case 1: return L"warning: some files were not extracted";
        case 2: return L"fatal error";
        case 7: return L"command line error";
        case 8: return L"not enough memory";
        case 255: return L"stopped before completion";
        default: return L"unexpected exit code";
    }
}

inline std::wstring Trim(const std::wstring& text) {
    const auto begin = text.find_first_not_of(L" \t\r\n");
    if (begin == std::wstring::npos) return L"";
    const auto end = text.find_last_not_of(L" \t\r\n");
    return text.substr(begin, end - begin + 1);
}

inline std::vector<std::wstring> Lines(const std::wstring& text) {
    std::vector<std::wstring> lines;
    size_t start = 0;
    while (start <= text.size()) {
        const auto end = text.find(L'\n', start);
        std::wstring line = text.substr(start, end == std::wstring::npos ? std::wstring::npos : end - start);
        if (!line.empty() && line.back() == L'\r') line.pop_back();
        lines.push_back(line);
        if (end == std::wstring::npos) break;
        start = end + 1;
    }
    return lines;
}

inline std::wstring Truncate(const std::wstring& text, size_t limit) {
    if (text.size() <= limit) return text;
    return text.substr(0, limit - 1) + kEllipsis;
}

inline std::wstring Win32Message(DWORD error) {
    LPWSTR buffer = nullptr;
    const DWORD length = FormatMessageW(FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr, error, 0, reinterpret_cast<LPWSTR>(&buffer), 0, nullptr);
    std::wstring message = length && buffer ? Trim(std::wstring(buffer, length)) : L"";
    if (buffer) LocalFree(buffer);
    return message;
}

// Positive results up to 255 are 7-Zip exit codes and small negative results are negated Win32 errors from launching or
// supervising it; anything else is the raw process status (for example an NTSTATUS from a crash), printed in hex.
constexpr int kMaxSevenZipExitCode = 255;
constexpr int kMaxWin32Error = 0xFFFF;

inline std::wstring HexStatus(int code) {
    WCHAR text[16];
    wsprintfW(text, L"0x%08X", static_cast<unsigned>(code));
    return text;
}

inline std::wstring DescribeResult(int code) {
    if (code >= 0 && code <= kMaxSevenZipExitCode) {
        return L"7-Zip exit code " + std::to_wstring(code) + L" (" + SevenZipMeaning(code) + L")";
    }
    if (code < 0 && -static_cast<long long>(code) <= kMaxWin32Error) {
        const DWORD error = static_cast<DWORD>(-static_cast<long long>(code));
        std::wstring message = Win32Message(error);
        return L"Windows error " + std::to_wstring(error) + L" while running 7-Zip" + (message.empty() ? L"" : L" (" + message + L")");
    }
    return L"7-Zip terminated with status " + HexStatus(code);
}

inline bool EqualsIgnoreCase(const std::wstring& left, const std::wstring& right) {
    return left.size() == right.size() && _wcsnicmp(left.c_str(), right.c_str(), left.size()) == 0;
}

// 7-Zip reports failures as "<operation> ERROR: <reason>" or "ERROR: <operation> : <reason> : <path>"; it also echoes the
// bare archive path after "ERROR:" before an open failure, which names nothing and is skipped.
inline std::wstring Headline(int code, const std::wstring& output, const std::wstring& archive) {
    const auto separator = archive.find_last_of(L"\\/");
    const std::wstring archiveName = separator == std::wstring::npos ? archive : archive.substr(separator + 1);
    std::wstring fallback;
    for (const std::wstring& raw : Lines(output)) {
        const std::wstring line = Trim(raw);
        const auto marker = line.find(L"ERROR");
        if (marker == std::wstring::npos) continue;
        const auto colon = line.find(L':', marker);
        const std::wstring detail = colon == std::wstring::npos ? L"" : Trim(line.substr(colon + 1));
        if (detail.empty() || EqualsIgnoreCase(detail, archive) || EqualsIgnoreCase(detail, archiveName)) continue;
        if (detail.find(L" : ") != std::wstring::npos) return Truncate(line, kHeadlineLimit);
        if (fallback.empty()) fallback = line;
    }
    if (!fallback.empty()) return Truncate(fallback, kHeadlineLimit);
    return DescribeResult(code);
}

inline std::wstring Compose(int code, const std::wstring& archive, const std::wstring& destination, const std::wstring& output,
                            const std::wstring& timestamp, const std::wstring& windowsVersion) {
    std::wstring report = L"DeepSeek Harness installer: extraction failed\r\n";
    report += L"Time: " + timestamp + L"\r\n";
    report += L"Result: " + DescribeResult(code) + L"\r\n";
    report += L"Archive: " + archive + L"\r\n";
    report += L"Destination: " + destination + L"\r\n";
    report += L"Windows: " + windowsVersion + L"\r\n";
    report += L"\r\n" + std::wstring(kOutputMarker) + L"\r\n";
    const std::wstring trimmed = Trim(output);
    if (trimmed.empty()) {
        report += L"(none)\r\n";
    } else {
        for (const std::wstring& line : Lines(trimmed)) report += line + L"\r\n";
    }
    return report;
}

// The expanded panel adds 7-Zip's own lines beneath the result; long lines are cut and a trailing note counts what the
// saved report still holds. Header fields already appear in the report file and clipboard.
inline std::wstring Excerpt(const std::wstring& report, size_t maxLines = kExcerptLines, size_t maxChars = kExcerptChars) {
    std::vector<std::wstring> lines;
    bool inOutput = false;
    for (const std::wstring& line : Lines(Trim(report))) {
        if (inOutput) lines.push_back(line);
        else if (line.rfind(L"Result: ", 0) == 0) lines.push_back(line);
        else if (line == kOutputMarker) inOutput = true;
    }
    std::wstring excerpt;
    size_t shown = 0;
    for (const std::wstring& line : lines) {
        const std::wstring cut = Truncate(line, kExcerptLineLimit);
        if (shown == maxLines || excerpt.size() + cut.size() + 2 > maxChars) break;
        excerpt += (shown ? L"\r\n" : L"") + cut;
        ++shown;
    }
    if (shown < lines.size()) {
        excerpt += L"\r\n" + std::wstring(1, kEllipsis) + L" (" + std::to_wstring(lines.size() - shown) + L" more lines in the saved report)";
    }
    return excerpt;
}

// A cut inside a multi-byte sequence would make the whole UTF-8 attempt fail; drop the incomplete tail first.
inline void TrimPartialUtf8(std::string& bytes) {
    size_t trailing = 0;
    while (trailing < 3 && trailing < bytes.size() && (static_cast<unsigned char>(bytes[bytes.size() - 1 - trailing]) & 0xC0) == 0x80) ++trailing;
    if (trailing >= bytes.size()) return;
    const unsigned char lead = static_cast<unsigned char>(bytes[bytes.size() - 1 - trailing]);
    const size_t expected = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
    if (expected > trailing + 1) bytes.resize(bytes.size() - 1 - trailing);
}

inline std::wstring Decode(const std::string& bytes) {
    if (bytes.empty()) return L"";
    for (UINT codePage : {static_cast<UINT>(CP_UTF8), static_cast<UINT>(CP_ACP)}) {
        const DWORD flags = codePage == CP_UTF8 ? MB_ERR_INVALID_CHARS : 0;
        const int length = MultiByteToWideChar(codePage, flags, bytes.data(), static_cast<int>(bytes.size()), nullptr, 0);
        if (length <= 0) continue;
        std::wstring text(static_cast<size_t>(length), L'\0');
        MultiByteToWideChar(codePage, flags, bytes.data(), static_cast<int>(bytes.size()), &text[0], length);
        return text;
    }
    return L"(undecodable 7-Zip output)";
}

// The saved report keeps everything 7-Zip wrote; only pathological output beyond kOutputLimit is cut, and the cut is recorded.
inline std::wstring ReadOutput(LPCWSTR path) {
    HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return L"";
    std::string bytes;
    char buffer[8192];
    DWORD count = 0;
    bool truncated = false;
    while (ReadFile(file, buffer, sizeof(buffer), &count, nullptr) && count) {
        if (bytes.size() + count > kOutputLimit) {
            bytes.append(buffer, kOutputLimit - bytes.size());
            truncated = true;
            break;
        }
        bytes.append(buffer, count);
    }
    CloseHandle(file);
    if (truncated) TrimPartialUtf8(bytes);
    std::wstring output = Decode(bytes);
    if (truncated) output += L"\r\n[7-Zip output truncated after " + std::to_wstring(kOutputLimit / (1024 * 1024)) + L" MiB]\r\n";
    return output;
}

inline std::wstring Timestamp() {
    SYSTEMTIME now;
    GetLocalTime(&now);
    WCHAR text[32];
    wsprintfW(text, L"%04u-%02u-%02u %02u:%02u:%02u", now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond);
    return text;
}

inline std::wstring WindowsVersion() {
    typedef LONG(WINAPI * RtlGetVersionFn)(PRTL_OSVERSIONINFOW);
    HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
    auto getVersion = ntdll ? reinterpret_cast<RtlGetVersionFn>(GetProcAddress(ntdll, "RtlGetVersion")) : nullptr;
    RTL_OSVERSIONINFOW info = {};
    info.dwOSVersionInfoSize = sizeof(info);
    if (!getVersion || getVersion(&info) != 0) return L"unknown";
    WCHAR text[64];
    wsprintfW(text, L"%u.%u.%u", info.dwMajorVersion, info.dwMinorVersion, info.dwBuildNumber);
    return text;
}

inline bool WriteUtf8(LPCWSTR path, const std::wstring& text) {
    std::wstring directory(path);
    const auto separator = directory.find_last_of(L"\\/");
    if (separator != std::wstring::npos) {
        directory.resize(separator);
        const int created = SHCreateDirectoryExW(nullptr, directory.c_str(), nullptr);
        if (created != ERROR_SUCCESS && created != ERROR_ALREADY_EXISTS && created != ERROR_FILE_EXISTS) return false;
    }
    const int length = WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), nullptr, 0, nullptr, nullptr);
    if (length <= 0) return false;
    std::string bytes("\xEF\xBB\xBF", 3);
    bytes.resize(3 + static_cast<size_t>(length));
    WideCharToMultiByte(CP_UTF8, 0, text.data(), static_cast<int>(text.size()), &bytes[3], length, nullptr, nullptr);
    HANDLE file = CreateFileW(path, GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (file == INVALID_HANDLE_VALUE) return false;
    DWORD written = 0;
    const bool complete = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr) && written == bytes.size();
    CloseHandle(file);
    return complete;
}

inline bool CopyToClipboard(HWND owner, const std::wstring& text) {
    const size_t bytes = (text.size() + 1) * sizeof(wchar_t);
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE, bytes);
    if (!memory) return false;
    void* target = GlobalLock(memory);
    if (!target) { GlobalFree(memory); return false; }
    memcpy(target, text.c_str(), bytes);
    GlobalUnlock(memory);
    bool copied = false;
    for (int attempt = 0; attempt < 5 && !copied; ++attempt) {
        if (attempt) Sleep(50);
        if (!OpenClipboard(owner)) continue;
        copied = EmptyClipboard() && SetClipboardData(CF_UNICODETEXT, memory) != nullptr;
        CloseClipboard();
    }
    if (!copied) GlobalFree(memory);
    return copied;
}

struct DialogStrings {
    LPCWSTR title;
    LPCWSTR heading;
    LPCWSTR copy;
    LPCWSTR expand;
    LPCWSTR collapse;
    LPCWSTR footer;
    LPCWSTR copied;
};

struct DialogState {
    const std::wstring* report;
    const DialogStrings* strings;
};

constexpr int kCopyButton = 1001;

inline HRESULT CALLBACK DialogCallback(HWND dialog, UINT notification, WPARAM wparam, LPARAM, LONG_PTR data) {
    auto* state = reinterpret_cast<DialogState*>(data);
    if (notification == TDN_BUTTON_CLICKED && static_cast<int>(wparam) == kCopyButton && state) {
        if (CopyToClipboard(dialog, *state->report)) {
            SendMessageW(dialog, TDM_SET_ELEMENT_TEXT, TDE_FOOTER, reinterpret_cast<LPARAM>(state->strings->copied));
        }
        return S_FALSE;
    }
    return S_OK;
}

// The task dialog comes from the comctl32 v6 the installer already loads; without it a message box carries the headline.
inline void Show(HWND parent, const std::wstring& headline, const std::wstring& excerpt, const std::wstring& report, const DialogStrings& strings) {
    typedef HRESULT(WINAPI * TaskDialogIndirectFn)(const TASKDIALOGCONFIG*, int*, int*, BOOL*);
    HMODULE comctl = GetModuleHandleW(L"comctl32.dll");
    if (!comctl) comctl = LoadLibraryW(L"comctl32.dll");
    auto taskDialog = comctl ? reinterpret_cast<TaskDialogIndirectFn>(GetProcAddress(comctl, "TaskDialogIndirect")) : nullptr;
    if (taskDialog) {
        DialogState state{&report, &strings};
        TASKDIALOG_BUTTON buttons[] = {{kCopyButton, strings.copy}};
        TASKDIALOGCONFIG config = {};
        config.cbSize = sizeof(config);
        config.hwndParent = parent;
        config.dwFlags = TDF_ALLOW_DIALOG_CANCELLATION | TDF_POSITION_RELATIVE_TO_WINDOW;
        config.dwCommonButtons = TDCBF_OK_BUTTON;
        config.pszWindowTitle = strings.title;
        config.pszMainIcon = TD_WARNING_ICON;
        config.pszMainInstruction = strings.heading;
        config.pszContent = headline.c_str();
        config.cButtons = 1;
        config.pButtons = buttons;
        config.nDefaultButton = IDOK;
        config.pszExpandedInformation = excerpt.c_str();
        config.pszExpandedControlText = strings.collapse;
        config.pszCollapsedControlText = strings.expand;
        config.pszFooterIcon = TD_INFORMATION_ICON;
        config.pszFooter = strings.footer;
        config.pfCallback = DialogCallback;
        config.lpCallbackData = reinterpret_cast<LONG_PTR>(&state);
        config.cxWidth = 320;
        int pressed = 0;
        if (SUCCEEDED(taskDialog(&config, &pressed, nullptr, nullptr))) return;
    }
    const std::wstring text = std::wstring(strings.heading) + L"\r\n\r\n" + headline + L"\r\n\r\n" + strings.footer;
    MessageBoxW(parent, text.c_str(), strings.title, MB_OK | MB_ICONEXCLAMATION | MB_SETFOREGROUND);
}

}  // namespace extract_report
