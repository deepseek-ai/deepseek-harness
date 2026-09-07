#include <Windows.h>
#include <cstdio>
#include <cstddef>

#define P(expr) printf("%-52s = %llu\n", #expr, (unsigned long long)(expr))

int wmain()
{
  P(sizeof(void*));
  P(sizeof(HANDLE));
  P(sizeof(STARTUPINFOW));
  P(offsetof(STARTUPINFOW, dwFlags));
  P(offsetof(STARTUPINFOW, hStdInput));
  P(offsetof(STARTUPINFOW, hStdOutput));
  P(offsetof(STARTUPINFOW, hStdError));
  P(sizeof(PROCESS_INFORMATION));
  P(offsetof(PROCESS_INFORMATION, hProcess));
  P(offsetof(PROCESS_INFORMATION, hThread));
  P(offsetof(PROCESS_INFORMATION, dwProcessId));
  P(CREATE_SUSPENDED);
  P(CREATE_UNICODE_ENVIRONMENT);
  P(STARTF_USESTDHANDLES);
  P(HANDLE_FLAG_INHERIT);
  P(INFINITE);
  P(WAIT_TIMEOUT);
  P(STD_INPUT_HANDLE);
  P(STD_OUTPUT_HANDLE);
  P(STD_ERROR_HANDLE);
  P(FORMAT_MESSAGE_FROM_SYSTEM);
  P(FORMAT_MESSAGE_IGNORE_INSERTS);
  P(ERROR_INSUFFICIENT_BUFFER);
  P(ERROR_BROKEN_PIPE);
  P(ERROR_NO_DATA);
  P(sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION));
  P(offsetof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, ActiveProcesses));
  P((int)JobObjectBasicAccountingInformation);
  P(sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION));
  P(offsetof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION, BasicLimitInformation) + offsetof(JOBOBJECT_BASIC_LIMIT_INFORMATION, LimitFlags));
  P((int)JobObjectExtendedLimitInformation);
  P(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);

  static_assert(sizeof(STARTUPINFOW) == 104, "STARTUPINFOW size");
  static_assert(sizeof(PROCESS_INFORMATION) == 24, "PROCESS_INFORMATION size");
  static_assert(sizeof(HANDLE) == 8, "HANDLE size");
  static_assert(CREATE_SUSPENDED == 0x4, "suspended process flag");
  static_assert(CREATE_UNICODE_ENVIRONMENT == 0x400, "Unicode environment flag");
  static_assert(STARTF_USESTDHANDLES == 0x100, "std handles flag");
  static_assert(HANDLE_FLAG_INHERIT == 0x1, "inherit flag");
  static_assert(WAIT_TIMEOUT == 258, "zero-time wait timeout");
  static_assert(sizeof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION) == 48, "job accounting size");
  static_assert(offsetof(JOBOBJECT_BASIC_ACCOUNTING_INFORMATION, ActiveProcesses) == 40, "active process offset");
  static_assert(JobObjectBasicAccountingInformation == 1, "basic accounting class");
  static_assert(sizeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION) == 144, "job extended limit size");
  static_assert(offsetof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION, BasicLimitInformation) + offsetof(JOBOBJECT_BASIC_LIMIT_INFORMATION, LimitFlags) == 16, "job LimitFlags offset");
  static_assert(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE == 0x2000, "kill on job close flag");
  static_assert(JobObjectExtendedLimitInformation == 9, "extended limit class");
  printf("\nstatic_asserts passed\n");
  return 0;
}
