// Own a console so the test never interrupts its caller's terminal.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <string>
#pragma comment(lib, "user32.lib")

BOOL WINAPI ignoreInterrupt(DWORD event) {
  return event == CTRL_C_EVENT || event == CTRL_BREAK_EVENT;
}

int wmain(int count, wchar_t** args) {
  if (count != 7) return 2;
  FreeConsole();
  if (!AllocConsole()) return 3;
  ShowWindow(GetConsoleWindow(), SW_HIDE);
  SetEnvironmentVariableW(L"ELECTRON_RUN_AS_NODE", L"1");
  std::wstring command = L"\"" + std::wstring(args[1]) + L"\" --expose-internals \"" + args[2]
    + L"\" \"" + args[3] + L"\" \"" + args[4] + L"\"";
  STARTUPINFOW startup{};
  startup.cb = sizeof(startup);
  HANDLE job = CreateJobObjectW(nullptr, nullptr);
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) return 4;
  PROCESS_INFORMATION child{};
  if (!CreateProcessW(args[1], command.data(), nullptr, nullptr, FALSE, CREATE_SUSPENDED, nullptr, nullptr, &startup, &child)) return 4;
  if (!AssignProcessToJobObject(job, child.hProcess)) { TerminateProcess(child.hProcess, 1); WaitForSingleObject(child.hProcess, INFINITE); CloseHandle(child.hThread); CloseHandle(child.hProcess); CloseHandle(job); return 4; }
  ResumeThread(child.hThread);
  CloseHandle(child.hThread);
  bool ready = false;
  for (int attempt = 0; attempt < 1500; ++attempt) {
    if (GetFileAttributesW(args[4]) != INVALID_FILE_ATTRIBUTES) { ready = true; break; }
    if (WaitForSingleObject(child.hProcess, 10) != WAIT_TIMEOUT) break;
  }
  const DWORD event = static_cast<DWORD>(wcstoul(args[6], nullptr, 10));
  const bool signalled = ready && SetConsoleCtrlHandler(ignoreInterrupt, TRUE) && GenerateConsoleCtrlEvent(event, 0);
  DWORD code = 0;
  const bool completed = signalled && WaitForSingleObject(child.hProcess, 15000) == WAIT_OBJECT_0
    && GetExitCodeProcess(child.hProcess, &code);
  if (!completed) { TerminateProcess(child.hProcess, 1); WaitForSingleObject(child.hProcess, INFINITE); }
  FreeConsole();
  FILE* report = nullptr;
  _wfopen_s(&report, args[5], L"w");
  if (report) { fprintf(report, "ready=%d signalled=%d completed=%d code=%lu\n", ready, signalled, completed, code); fclose(report); }
  CloseHandle(child.hProcess);
  CloseHandle(job);
  return completed && code == (event == CTRL_C_EVENT ? 130u : 131u) ? 0 : 5;
}
