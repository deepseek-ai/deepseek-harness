#include <Windows.h>
#include <sddl.h>
#include <AclAPI.h>
#include <cstdio>
#include <cstddef>

#define P(expr) printf("%-52s = %llu\n", #expr, (unsigned long long)(expr))

int wmain()
{
  P(sizeof(TRUSTEE_W));
  P(offsetof(TRUSTEE_W, ptstrName));
  P(sizeof(EXPLICIT_ACCESS_W));
  P(offsetof(EXPLICIT_ACCESS_W, Trustee));
  P(sizeof(SID_AND_ATTRIBUTES));
  P(offsetof(SID_AND_ATTRIBUTES, Attributes));
  P(sizeof(TOKEN_GROUPS));
  P(offsetof(TOKEN_GROUPS, Groups));
  P(SECURITY_MAX_SID_SIZE);
  P(SID_MAX_SUB_AUTHORITIES);
  P(TOKEN_ASSIGN_PRIMARY);
  P(TOKEN_DUPLICATE);
  P(TOKEN_QUERY);
  P(TOKEN_ADJUST_DEFAULT);
  P(SE_GROUP_LOGON_ID);
  P(FILE_GENERIC_WRITE);
  P(STANDARD_RIGHTS_WRITE);
  P(DELETE);
  P(FILE_DELETE_CHILD);
  P(((FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE));
  P(FILE_SHARE_READ);
  P(FILE_SHARE_WRITE);
  P(FILE_SHARE_DELETE);
  P(GENERIC_READ);
  P(GENERIC_WRITE);
  P(OPEN_ALWAYS);
  P(LOCKFILE_EXCLUSIVE_LOCK);
  P(LOCKFILE_FAIL_IMMEDIATELY);
  P(ERROR_LOCK_VIOLATION);
  P(INHERITED_ACE);
  P(DISABLE_MAX_PRIVILEGE);
  P(LUA_TOKEN);
  P(WRITE_RESTRICTED);
  P((int)WinWorldSid);
  P((int)TokenGroups);
  P((int)SE_FILE_OBJECT);
  P(DACL_SECURITY_INFORMATION);
  P((int)TRUSTEE_IS_UNKNOWN);
  P((int)TRUSTEE_IS_SID);
  P((int)GRANT_ACCESS);
  P((int)REVOKE_ACCESS);
  P(SUB_CONTAINERS_AND_OBJECTS_INHERIT);
  P(CONTAINER_INHERIT_ACE);
  P(MAX_PATH);
  P(ERROR_SUCCESS);
  P((int)ACCESS_DENIED_ACE_TYPE);
  P((int)DENY_ACCESS);
  P(LABEL_SECURITY_INFORMATION);
  P((int)SYSTEM_MANDATORY_LABEL_ACE_TYPE);
  P(SYSTEM_MANDATORY_LABEL_NO_WRITE_UP);
  P((int)TokenIntegrityLevel);
  P(SE_GROUP_INTEGRITY);
  P((int)WinLowLabelSid);
  P(sizeof(TOKEN_MANDATORY_LABEL));
  P(offsetof(TOKEN_MANDATORY_LABEL, Label));
  P(sizeof(ACL));
  P(sizeof(SYSTEM_MANDATORY_LABEL_ACE));
  P(ACL_REVISION);
  P(LPTR);

  static_assert(sizeof(EXPLICIT_ACCESS_W) == 48, "EXPLICIT_ACCESS_W size");
  static_assert(sizeof(TRUSTEE_W) == 32, "TRUSTEE_W size");
  static_assert(sizeof(SID_AND_ATTRIBUTES) == 16, "SID_AND_ATTRIBUTES size");
  static_assert(sizeof(TOKEN_MANDATORY_LABEL) == 16, "TOKEN_MANDATORY_LABEL size");
  static_assert(sizeof(ACL) == 8, "ACL header size");
  static_assert(sizeof(SYSTEM_MANDATORY_LABEL_ACE) == 12, "mandatory label ACE body size");
  static_assert(ACL_REVISION == 2, "ACL revision");
  static_assert(LPTR == 0x40, "LocalAlloc flags");
  static_assert(SECURITY_MAX_SID_SIZE == 68, "SECURITY_MAX_SID_SIZE");
  static_assert(TOKEN_QUERY == 0x8 && TOKEN_DUPLICATE == 0x2 && TOKEN_ADJUST_DEFAULT == 0x80 && TOKEN_ASSIGN_PRIMARY == 0x1, "token rights");
  static_assert(SE_GROUP_LOGON_ID == 0xC0000000, "logon id attr");
  static_assert(FILE_GENERIC_WRITE == 0x120116, "generic write");
  static_assert(DELETE == 0x10000 && FILE_DELETE_CHILD == 0x40, "delete rights");
  static_assert(((FILE_GENERIC_WRITE | DELETE | FILE_DELETE_CHILD) & ~STANDARD_RIGHTS_WRITE) == 0x110156, "sandbox grant mask");
  static_assert(FILE_SHARE_READ == 0x1 && FILE_SHARE_WRITE == 0x2 && FILE_SHARE_DELETE == 0x4, "share modes");
  static_assert(OPEN_ALWAYS == 4, "open always");
  static_assert(LOCKFILE_EXCLUSIVE_LOCK == 0x2 && LOCKFILE_FAIL_IMMEDIATELY == 0x1, "lockfile flags");
  static_assert(ERROR_LOCK_VIOLATION == 33, "lock violation");
  static_assert(INHERITED_ACE == 0x10, "inherited ace flag");
  static_assert(GRANT_ACCESS == 1 && REVOKE_ACCESS == 4, "access modes");
  static_assert(SUB_CONTAINERS_AND_OBJECTS_INHERIT == 0x3, "inheritance");
  printf("\nstatic_asserts passed\n");
  return 0;
}
