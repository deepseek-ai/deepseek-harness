// Windows data cleanup: protect shell roots and pin directory names while enumerating.
#pragma once
#include <shlobj.h>
#include <string>
#include <vector>

namespace uninstall_data {
struct Failure { std::wstring path; DWORD error; };
using Failures = std::vector<Failure>;
inline DWORD Record(Failures* failures, const std::wstring& path, DWORD error) {
    if (error && failures) failures->push_back({path, error});
    return error;
}
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

inline size_t RootLength(const std::wstring& path) {
    if (path.size() >= 3 && path[1] == L':' && path[2] == L'\\') return 3;
    if (path.compare(0, 2, L"\\\\") != 0) return 0;
    const size_t server = path.find(L'\\', 2);
    if (server == std::wstring::npos || server == 2) return 0;
    const size_t share = path.find(L'\\', server + 1);
    if (server + 1 == path.size() || share == server + 1) return 0;
    return share == std::wstring::npos ? path.size() : share + 1;
}

// DSH_HOME accepts Node's tilde and separator spellings; relative roots remain
// unverifiable because the application's working directory is not available here.
inline bool NormalizeHome(LPCWSTR input, std::wstring& result) {
    std::wstring value = input ? input : L"";
    if (value.find_first_not_of(L" \t\r\n") == std::wstring::npos) value = L"~/.dsh";
    if (value == L"~" || value.compare(0, 2, L"~/") == 0 || value.compare(0, 2, L"~\\") == 0) {
        WCHAR buffer[32768];
        DWORD length = GetEnvironmentVariableW(L"USERPROFILE", buffer, ARRAYSIZE(buffer));
        std::wstring profile;
        if (length && length < ARRAYSIZE(buffer)) profile.assign(buffer, length);
        else {
            if (length) return false;
            PWSTR folder = nullptr;
            if (FAILED(SHGetKnownFolderPath(FOLDERID_Profile, KF_FLAG_DONT_VERIFY, nullptr, &folder))) return false;
            profile = folder;
            CoTaskMemFree(folder);
        }
        value = profile + (value.size() > 1 ? L"\\" + value.substr(2) : L"");
    }
    for (auto& character : value) if (character == L'/') character = L'\\';
    if (_wcsnicmp(value.c_str(), L"\\\\?\\UNC\\", 8) == 0) value = L"\\\\" + value.substr(8);
    else if (value.compare(0, 4, L"\\\\?\\") == 0) value = value.substr(4);
    const size_t root = RootLength(value);
    if (!root || value.compare(0, 4, L"\\\\.\\") == 0) return false;
    if (wcspbrk(value.c_str() + (value[1] == L':' ? 2 : 0), L":*?\"<>|\r\n\t")) return false;
    WCHAR buffer[32768];
    const DWORD length = GetFullPathNameW(value.c_str(), ARRAYSIZE(buffer), buffer, nullptr);
    if (!length || length >= ARRAYSIZE(buffer)) return false;
    result.assign(buffer, length);
    const size_t normalizedRoot = RootLength(result);
    while (result.size() > normalizedRoot && result.back() == L'\\') result.pop_back();
    for (size_t start = normalizedRoot; start < result.size();) {
        size_t end = result.find(L'\\', start);
        if (end == std::wstring::npos) end = result.size();
        if (end == start || result[end - 1] == L'.' || result[end - 1] == L' ') return false;
        start = end + 1;
    }
    return true;
}

struct Ancestor {
    BY_HANDLE_FILE_INFORMATION identity;
    std::wstring suffix;
};
// Keep absent suffixes relative to existing ancestors. File identities also match
// local SMB shares, mapped drives and junction aliases whose path strings differ.
inline DWORD Ancestors(std::wstring path, std::vector<Ancestor>& ancestors) {
    std::wstring suffix;
    const size_t root = RootLength(path);
    for (;;) {
        const std::wstring extended = path.compare(0, 2, L"\\\\") == 0
            ? L"\\\\?\\UNC\\" + path.substr(2) : L"\\\\?\\" + path;
        HANDLE handle = CreateFileW(extended.c_str(), FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, nullptr, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, nullptr);
        if (handle == INVALID_HANDLE_VALUE) {
            const DWORD error = GetLastError();
            if ((error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) || path.size() <= root) return error;
        } else {
            BY_HANDLE_FILE_INFORMATION identity{};
            const BOOL read = GetFileInformationByHandle(handle, &identity);
            const DWORD error = read ? ERROR_SUCCESS : GetLastError();
            CloseHandle(handle);
            if (error) return error;
            if (!(identity.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) return ERROR_DIRECTORY;
            ancestors.push_back({identity, suffix});
        }
        if (path.size() <= root) break;
        const size_t separator = path.find_last_of(L'\\');
        suffix = path.substr(separator + 1) + (suffix.empty() ? L"" : L"\\" + suffix);
        path.resize(separator < root ? root : separator);
    }
    return ERROR_SUCCESS;
}

inline DWORD CheckHome(const std::wstring& target, LPCWSTR input, bool* homeFailure = nullptr) {
    if (homeFailure) *homeFailure = true;
    std::wstring home;
    if (!NormalizeHome(input, home)) return ERROR_INVALID_NAME;
    std::vector<Ancestor> protectedAncestors, targetAncestors;
    DWORD error = Ancestors(home, protectedAncestors);
    if (error) return error;
    if (homeFailure) *homeFailure = false;
    error = Ancestors(target, targetAncestors);
    if (error) return error;
    if (homeFailure) *homeFailure = true;
    for (const auto& a : protectedAncestors) for (const auto& b : targetAncestors) {
        if (a.identity.dwVolumeSerialNumber == b.identity.dwVolumeSerialNumber
            && a.identity.nFileIndexHigh == b.identity.nFileIndexHigh && a.identity.nFileIndexLow == b.identity.nFileIndexLow
            && (a.suffix.empty() || b.suffix.empty() || Contains(a.suffix, b.suffix) || Contains(b.suffix, a.suffix)))
            return ERROR_ACCESS_DENIED;
    }
    return ERROR_SUCCESS;
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
inline DWORD RemoveTree(const std::wstring& path, Failures* failures = nullptr) {
    const std::wstring extended = L"\\\\?\\" + path;
    DWORD attributes = GetFileAttributesW(extended.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        DWORD error = GetLastError();
        return error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND ? ERROR_SUCCESS : Record(failures, path, error);
    }
    DWORD first = ERROR_SUCCESS;
    if ((attributes & FILE_ATTRIBUTE_DIRECTORY) && !(attributes & FILE_ATTRIBUTE_REPARSE_POINT)) {
        Handles pinned;
        DWORD error = Pin(path, pinned);
        if (error) return Record(failures, path, error);
        WIN32_FIND_DATAW entry{};
        HANDLE search = FindFirstFileW((extended + L"\\*").c_str(), &entry);
        if (search == INVALID_HANDLE_VALUE) {
            error = GetLastError();
            if (error != ERROR_FILE_NOT_FOUND) return Record(failures, path, error);
        } else {
            do {
                if (wcscmp(entry.cFileName, L".") == 0 || wcscmp(entry.cFileName, L"..") == 0) continue;
                error = RemoveTree(path + L"\\" + entry.cFileName, failures);
                if (error && !first) first = error;
            } while (FindNextFileW(search, &entry));
            error = GetLastError();
            FindClose(search);
            if (error != ERROR_NO_MORE_FILES && !first) first = Record(failures, path, error);
        }
    }
    DWORD error = Record(failures, path, Unlink(extended, attributes));
    return first ? first : error;
}

// Never select a shell folder, its ancestor, Windows/Program Files descendants,
// a path overlapping the installation, or a path overlapping the protected root
// (the configured Harness home). Linked descendants are unlinked only.
inline DWORD Remove(LPCWSTR input, LPCWSTR installation, LPCWSTR protectedRoot, Failures* failures = nullptr) {
    std::wstring path, install;
    if (!Normalize(input, path) || !Normalize(installation, install)) return ERROR_INVALID_NAME;
    if (Contains(path, install) || Contains(install, path)) return ERROR_ACCESS_DENIED;
    if (protectedRoot && *protectedRoot) {
        // An unusable protected root cannot establish separation from retained data.
        const DWORD error = CheckHome(path, protectedRoot);
        if (error) return error;
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
    return RemoveTree(path, failures);
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
