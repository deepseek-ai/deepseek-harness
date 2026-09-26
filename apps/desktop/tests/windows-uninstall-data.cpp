// Native cleanup regressions operate only in the caller's private test directory.
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#define UNICODE
#include <windows.h>
#include <cassert>
#include "../installer/uninstall-data.h"

static void File(const std::wstring& path, DWORD attributes = FILE_ATTRIBUTE_NORMAL) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_NEW, attributes, nullptr);
    assert(file != INVALID_HANDLE_VALUE);
    DWORD count;
    assert(WriteFile(file, "retained", 8, &count, nullptr));
    CloseHandle(file);
}

static bool Exists(const std::wstring& path) { return GetFileAttributesW(path.c_str()) != INVALID_FILE_ATTRIBUTES; }

int wmain(int argc, wchar_t** argv) {
    assert(argc == 2);
    const std::wstring root = argv[1];
    const std::wstring installation = root + L"\\application";
    const std::wstring data = root + L"\\data";
    const std::wstring cache = data + L"\\Local Storage\\leveldb";
    assert(CreateDirectoryW(root.c_str(), nullptr));
    assert(CreateDirectoryW(installation.c_str(), nullptr));
    assert(CreateDirectoryW(data.c_str(), nullptr));
    assert(CreateDirectoryW((data + L"\\Local Storage").c_str(), nullptr));
    assert(CreateDirectoryW(cache.c_str(), nullptr));
    File(data + L"\\Local State");
    File(cache + L"\\CURRENT");
    File(cache + L"\\LOCK", FILE_ATTRIBUTE_READONLY);
    File(cache + L"\\MANIFEST");

    // Refused roots: the test root contains the installation; shell roots and malformed paths are rejected.
    assert(uninstall_data::Remove(root.c_str(), installation.c_str(), nullptr) == ERROR_ACCESS_DENIED);
    assert(uninstall_data::Remove(L"C:\\", installation.c_str(), nullptr) == ERROR_INVALID_NAME);
    assert(uninstall_data::Remove(L"relative", installation.c_str(), nullptr) == ERROR_INVALID_NAME);
    assert(uninstall_data::Remove(L"C:\\bad*", installation.c_str(), nullptr) == ERROR_INVALID_NAME);
    PWSTR profile = nullptr;
    assert(SUCCEEDED(SHGetKnownFolderPath(FOLDERID_Profile, 0, nullptr, &profile)));
    assert(uninstall_data::Remove(profile, installation.c_str(), nullptr) == ERROR_ACCESS_DENIED);
    CoTaskMemFree(profile);

    // A protected root overlapping the target in either direction, or an unusable one, stops removal.
    assert(uninstall_data::Remove(cache.c_str(), installation.c_str(), data.c_str()) == ERROR_ACCESS_DENIED);
    assert(uninstall_data::Remove(data.c_str(), installation.c_str(), cache.c_str()) == ERROR_ACCESS_DENIED);
    assert(uninstall_data::Remove(cache.c_str(), installation.c_str(), L"relative\\home") == ERROR_INVALID_NAME);
    assert(Exists(cache + L"\\CURRENT"));

    // A pinned directory cannot be renamed or replaced while the helper holds it.
    {
        uninstall_data::Handles pinned;
        assert(uninstall_data::Pin(cache, pinned) == ERROR_SUCCESS);
        assert(!MoveFileExW(cache.c_str(), (data + L"\\renamed").c_str(), 0));
        assert(GetLastError() == ERROR_SHARING_VIOLATION || GetLastError() == ERROR_ACCESS_DENIED);
    }
    assert(Exists(cache));

    // A locked file returns its error but every sibling, including a read-only one, is still removed.
    HANDLE held = CreateFileW((cache + L"\\CURRENT").c_str(), GENERIC_READ, FILE_SHARE_READ,
        nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    assert(held != INVALID_HANDLE_VALUE);
    assert(uninstall_data::Remove(cache.c_str(), installation.c_str(), nullptr) == ERROR_SHARING_VIOLATION);
    assert(Exists(cache + L"\\CURRENT"));
    assert(!Exists(cache + L"\\LOCK"));
    assert(!Exists(cache + L"\\MANIFEST"));
    CloseHandle(held);
    assert(uninstall_data::Remove(cache.c_str(), installation.c_str(), nullptr) == ERROR_SUCCESS);
    assert(Exists(data + L"\\Local State"));
    assert(uninstall_data::Remove(cache.c_str(), installation.c_str(), nullptr) == ERROR_SUCCESS);

    // Empty ordinary parents below the stop directory are removed; the stop directory and populated parents stay.
    const std::wstring scope = root + L"\\@scope";
    const std::wstring package = scope + L"\\package";
    assert(CreateDirectoryW(scope.c_str(), nullptr));
    assert(CreateDirectoryW(package.c_str(), nullptr));
    assert(uninstall_data::RemoveEmptyParents(package.c_str(), root.c_str()) == ERROR_DIR_NOT_EMPTY);
    assert(Exists(scope));
    assert(RemoveDirectoryW(package.c_str()));
    assert(uninstall_data::RemoveEmptyParents(root.c_str(), root.c_str()) == ERROR_ACCESS_DENIED);
    assert(uninstall_data::RemoveEmptyParents(package.c_str(), root.c_str()) == ERROR_SUCCESS);
    assert(!Exists(scope));
    assert(Exists(root));

    // A protected root elsewhere does not block removal.
    assert(uninstall_data::Remove(data.c_str(), installation.c_str(), (root + L"\\elsewhere").c_str()) == ERROR_SUCCESS);
    assert(!Exists(data));
    assert(RemoveDirectoryW(installation.c_str()));
    assert(RemoveDirectoryW(root.c_str()));
}
