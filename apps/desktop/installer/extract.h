// The pinned 7-Zip executable owns extraction; this pipe reader publishes its work percentage.
#pragma once
#include <string>
#include <vector>
#include "extract-progress.h"

struct InstallerHandle {
    HANDLE value = nullptr;
    InstallerHandle() = default;
    explicit InstallerHandle(HANDLE handle) : value(handle) {}
    InstallerHandle(const InstallerHandle&) = delete;
    InstallerHandle& operator=(const InstallerHandle&) = delete;
    ~InstallerHandle() { Close(); }
    void Close() {
        if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value);
        value = nullptr;
    }
};

struct InstallerAttributes {
    std::vector<unsigned char> storage;
    LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
    ~InstallerAttributes() { if (list) DeleteProcThreadAttributeList(list); }
    bool Initialize() {
        SIZE_T size = 0;
        InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
        storage.resize(size);
        auto* candidate = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(storage.data());
        if (!InitializeProcThreadAttributeList(candidate, 2, 0, &size)) return false;
        list = candidate;
        return true;
    }
};

static DWORD ExtractApplication(HWND parent, LPCWSTR tool, LPCWSTR archive, LPCWSTR destination, LPCWSTR log) {
    SECURITY_ATTRIBUTES security = {sizeof(security), nullptr, TRUE};
    InstallerHandle input, output;
    if (!CreatePipe(&input.value, &output.value, &security, 0)) return GetLastError();
    if (!SetHandleInformation(input.value, HANDLE_FLAG_INHERIT, 0)) return GetLastError();
    InstallerHandle errors(CreateFileW(log, GENERIC_WRITE, FILE_SHARE_READ, &security, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, nullptr));
    if (errors.value == INVALID_HANDLE_VALUE) return GetLastError();
    InstallerHandle nullInput(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr));
    if (nullInput.value == INVALID_HANDLE_VALUE) return GetLastError();
    InstallerHandle job(CreateJobObjectW(nullptr, nullptr));
    if (!job.value) return GetLastError();
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return GetLastError();
    InstallerAttributes attributes;
    if (!attributes.Initialize()) return GetLastError();
    HANDLE inherited[] = {nullInput.value, output.value, errors.value};
    if (!UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, inherited, sizeof(inherited), nullptr, nullptr) ||
        !UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_JOB_LIST, &job.value, sizeof(job.value), nullptr, nullptr)) return GetLastError();
    STARTUPINFOEXW startup = {};
    startup.StartupInfo.cb = sizeof(startup);
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = nullInput.value;
    startup.StartupInfo.hStdOutput = output.value;
    startup.StartupInfo.hStdError = errors.value;
    startup.lpAttributeList = attributes.list;
    // A final dot prevents a destination's trailing backslash from escaping its closing quote.
    std::wstring command = L"\"" + std::wstring(tool) + L"\" x -y -bso0 -bse2 -bsp1 -bb0 \"-o" + destination + L"\\.\" \"" + archive + L"\"";
    PROCESS_INFORMATION child = {};
    if (!CreateProcessW(tool, &command[0], nullptr, nullptr, TRUE,
        EXTENDED_STARTUPINFO_PRESENT | CREATE_NO_WINDOW, nullptr, nullptr, &startup.StartupInfo, &child)) return GetLastError();
    InstallerHandle process(child.hProcess), thread(child.hThread);
    output.Close();
    errors.Close();
    ExtractionProgress progress;
    char buffer[4096];
    DWORD count = 0;
    DWORD readError = ERROR_SUCCESS;
    while (true) {
        if (!ReadFile(input.value, buffer, sizeof(buffer), &count, nullptr)) { readError = GetLastError(); break; }
        if (!count) break;
        progress.Read(buffer, count);
        if (parent) SetPropW(parent, L"HarnessInstaller.ExtractProgress", reinterpret_cast<HANDLE>(static_cast<UINT_PTR>(progress.value)));
    }
    if (readError != ERROR_BROKEN_PIPE && readError != ERROR_SUCCESS) {
        TerminateJobObject(job.value, readError);
        WaitForSingleObject(process.value, INFINITE);
        return readError;
    }
    if (WaitForSingleObject(process.value, INFINITE) != WAIT_OBJECT_0) return GetLastError();
    DWORD result;
    if (!GetExitCodeProcess(process.value, &result)) return GetLastError();
    if (result == 0 && parent) SetPropW(parent, L"HarnessInstaller.ExtractProgress", reinterpret_cast<HANDLE>(100));
    return result;
}

// Runs on the NSIS worker; only an exit code of zero permits directory promotion.
extern "C" __declspec(dllexport) DWORD __cdecl InstallerExtract(HWND parent, LPCWSTR tool, LPCWSTR archive, LPCWSTR destination, LPCWSTR log) {
    try { return ExtractApplication(parent, tool, archive, destination, log); }
    catch (const std::bad_alloc&) { return ERROR_NOT_ENOUGH_MEMORY; }
}
