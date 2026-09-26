// Windows data cleanup: protect shell roots and pin directory names while enumerating.
#pragma once
#include <shlobj.h>
#include <string>
#include <vector>

namespace uninstall_data {
struct Handles {
    std::vector<HANDLE> values;
    Handles() = default;
    Handles(const Handles&) = delete;
    Handles& operator=(const Handles&) = delete;
    ~Handles() { for (HANDLE value : values) CloseHandle(value); }
};

inline bool Contains(const std::wstring& parent, const std::wstring& child) {
    return _wcsicmp(parent.c_str(), child.c_str()) == 0
        || (child.size() > parent.size() && child[parent.size()] == L'\\'
            && _wcsnicmp(parent.c_str(), child.c_str(), parent.size()) == 0);
}

inline bool Normalize(LPCWSTR input, std::wstring& result) {
    if (!input || wcslen(input) < 4 || input[1] != L':' || input[2] != L'\\') return false;
    if (wcspbrk(input + 3, L"/:*?\"<>|\r\n\t")) return false;
    WCHAR buffer[32768];
    DWORD length = GetFullPathNameW(input, ARRAYSIZE(buffer), buffer, nullptr);
    if (!length || length >= ARRAYSIZE(buffer)) return false;
    result.assign(buffer, length);
    length = GetLongPathNameW(result.c_str(), buffer, ARRAYSIZE(buffer));
    if (length > 0 && length < ARRAYSIZE(buffer)) result.assign(buffer, length);
    while (result.size() > 3 && result.back() == L'\\') result.pop_back();
    if (result.size() <= 3 || GetDriveTypeW(result.substr(0, 3).c_str()) != DRIVE_FIXED) return false;
    for (size_t start = 3; start < result.size();) {
        size_t end = result.find(L'\\', start);
        if (end == std::wstring::npos) end = result.size();
        if (end == start || result[end - 1] == L'.' || result[end - 1] == L' ') return false;
        start = end + 1;
    }
    return true;
}

// Listing access takes part in share checks, so the open handle refuses the DELETE access a rename or removal needs.
inline DWORD Pin(const std::wstring& path, Handles& handles) {
    HANDLE handle = CreateFileW((L"\\\\?\\" + path).c_str(), FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE, nullptr, OPEN_EXISTING,
        FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, nullptr);
    if (handle == INVALID_HANDLE_VALUE) return GetLastError();
    handles.values.push_back(handle);
    BY_HANDLE_FILE_INFORMATION info{};
    if (!GetFileInformationByHandle(handle, &info)) return GetLastError();
    if (!(info.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)
        || (info.dwFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT)) return ERROR_ACCESS_DENIED;
    return ERROR_SUCCESS;
}

inline DWORD Unlink(const std::wstring& extended, DWORD attributes) {
    if (attributes & FILE_ATTRIBUTE_READONLY) SetFileAttributesW(extended.c_str(), FILE_ATTRIBUTE_NORMAL);
    const BOOL removed = (attributes & FILE_ATTRIBUTE_DIRECTORY)
        ? RemoveDirectoryW(extended.c_str()) : DeleteFileW(extended.c_str());
    return removed ? ERROR_SUCCESS : GetLastError();
}

// Every sibling is attempted; the first error is returned after the whole tree has been visited.
inline DWORD RemoveTree(const std::wstring& path) {
    const std::wstring extended = L"\\\\?\\" + path;
    DWORD attributes = GetFileAttributesW(extended.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? ERROR_SUCCESS : error;
    }
    DWORD first = ERROR_SUCCESS;
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
        Handles pinned;
        DWORD error = Pin(path, pinned);
        if (error) return error;
        WIN32_FIND_DATAW entry{};
        HANDLE search = FindFirstFileW((extended + L"\\*").c_str(), &entry);
        if (search == INVALID_HANDLE_VALUE) {
            error = GetLastError();
            if (error != ERROR_FILE_NOT_FOUND) return error;
        } else {
            do {
                if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0) continue;
                error = RemoveTree(path + L"\\" + entry.cFileName);
                if (error && !first) first = error;
            } while (FindNextFileW(search, &entry));
            error = GetLastError();
            FindClose(search);
            if (error != ERROR_NO_MORE_FILES && !first) first = error;
        }
    }
    DWORD error = Unlink(extended, attributes);
    return first ? first : error;
}

// Never select a shell folder, its ancestor, Windows/Program Files descendants,
// a path overlapping the installation, or a path overlapping the protected root
// (the configured Harness home). Linked descendants are unlinked only.
inline DWORD Remove(LPCWSTR input, LPCWSTR installation, LPCWSTR protectedRoot) {
    std::wstring path, install;
    if (!Normalize(input, path) || !Normalize(installation, install)) return ERROR_INVALID_NAME;
    if (Contains(path, install) || Contains(install, path)) return ERROR_ACCESS_DENIED;
    if (protectedRoot && *protectedRoot) {
        std::wstring home;
        // An unusable protected root cannot establish separation from retained data.
        if (!Normalize(protectedRoot, home)) return ERROR_INVALID_NAME;
        if (Contains(path, home) || Contains(home, path)) return ERROR_ACCESS_DENIED;
    }
    struct ComScope {
        HRESULT result = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        ~ComScope() { if (SUCCEEDED(result)) CoUninitialize(); }
    } com;
    if (FAILED(com.result) && com.result != RPC_E_CHANGED_MODE) return ERROR_ACCESS_DENIED;
    // This helper is x86; the x64 Program Files known-folder id is unavailable to it.
    WCHAR nativePrograms[32768];
    DWORD bytes = sizeof(nativePrograms);
    if (RegGetValueW(HKEY_LOCAL_MACHINE, L"SOFTWARE\\Microsoft\\Windows\\CurrentVersion", L"ProgramFilesDir",
        RRF_RT_REG_SZ | RRF_SUBKEY_WOW6464KEY, nullptr, nativePrograms, &bytes) != ERROR_SUCCESS) return ERROR_ACCESS_DENIED;
    std::wstring nativeFolder;
    if (!Normalize(nativePrograms, nativeFolder) || Contains(path, nativeFolder) || Contains(nativeFolder, path)) return ERROR_ACCESS_DENIED;
    const KNOWNFOLDERID* protectedFolders[] = {&FOLDERID_Profile, &FOLDERID_RoamingAppData,
        &FOLDERID_LocalAppData, &FOLDERID_Desktop, &FOLDERID_Documents, &FOLDERID_Downloads,
        &FOLDERID_Pictures, &FOLDERID_Music, &FOLDERID_Videos, &FOLDERID_Public, &FOLDERID_ProgramData,
        &FOLDERID_Windows, &FOLDERID_ProgramFiles, &FOLDERID_ProgramFilesX86};
    for (const KNOWNFOLDERID* id : protectedFolders) {
        PWSTR value = nullptr;
        HRESULT result = SHGetKnownFolderPath(*id, KF_FLAG_DONT_VERIFY, nullptr, &value);
        if (FAILED(result)) return ERROR_ACCESS_DENIED;
        // Known-folder paths are already full paths; a redirected folder on another volume must stay protected.
        const std::wstring folder(value);
        CoTaskMemFree(value);
        if (Contains(path, folder)) return ERROR_ACCESS_DENIED;
        if ((id == &FOLDERID_Windows || id == &FOLDERID_ProgramFiles || id == &FOLDERID_ProgramFilesX86)
            && Contains(folder, path)) return ERROR_ACCESS_DENIED;
    }
    Handles parents;
    for (size_t end = path.find(L'\\', 3); end != std::wstring::npos; end = path.find(L'\\', end + 1)) {
        DWORD error = Pin(path.substr(0, end), parents);
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return ERROR_SUCCESS;
        if (error) return error;
    }
    // A selected root must be a real directory, even though links inside it may be removed.
    {
        Handles root;
        DWORD error = Pin(path, root);
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) return ERROR_SUCCESS;
        if (error) return error;
    }
    return RemoveTree(path);
}

// Remove the ordinary, empty directories between a removed path and its stop ancestor.
// A linked or populated parent ends the walk; the stop directory itself is never removed.
inline DWORD RemoveEmptyParents(LPCWSTR input, LPCWSTR stopInput) {
    std::wstring path, stop;
    if (!Normalize(input, path) || !Normalize(stopInput, stop)) return ERROR_INVALID_NAME;
    if (!Contains(stop, path) || _wcsicmp(stop.c_str(), path.c_str()) == 0) return ERROR_ACCESS_DENIED;
    for (size_t end = path.rfind(L'\\'); end != std::wstring::npos && end > stop.size(); end = path.rfind(L'\\', end - 1)) {
        const std::wstring parent = L"\\\\?\\" + path.substr(0, end);
        const DWORD attributes = GetFileAttributesW(parent.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) return GetLastError();
        if (!(attributes & FILE_ATTRIBUTE_DIRECTORY) || (attributes & FILE_ATTRIBUTE_REPARSE_POINT)) return ERROR_ACCESS_DENIED;
        if (!RemoveDirectoryW(parent.c_str())) return GetLastError();
    }
    return ERROR_SUCCESS;
}
}
