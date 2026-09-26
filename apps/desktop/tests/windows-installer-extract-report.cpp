// Extraction failure reports keep 7-Zip's evidence intact while the dialog headline and excerpt stay bounded.
#define WIN32_LEAN_AND_MEAN
#define UNICODE
#include <windows.h>
#include <cassert>
#include <string>
#include "../installer/extract-report.h"

extern "C" __declspec(dllimport) int __cdecl InstallerReportExtractFailure(
    HWND parent, int code, LPCWSTR archive, LPCWSTR destination, LPCWSTR log, LPCWSTR reportPath, int show,
    LPCWSTR title, LPCWSTR heading, LPCWSTR hint, LPCWSTR copy, LPCWSTR expand, LPCWSTR collapse, LPCWSTR savedFormat, LPCWSTR unsaved, LPCWSTR copied);

static bool Contains(const std::wstring& text, const std::wstring& needle) { return text.find(needle) != std::wstring::npos; }

static std::string ReadBytes(const std::wstring& path) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_READ, FILE_SHARE_READ, nullptr, OPEN_EXISTING, 0, nullptr);
    assert(file != INVALID_HANDLE_VALUE);
    std::string bytes(1 << 16, '\0');
    DWORD count = 0;
    const BOOL read = ReadFile(file, &bytes[0], static_cast<DWORD>(bytes.size()), &count, nullptr);
    assert(read);
    CloseHandle(file);
    bytes.resize(count);
    return bytes;
}

static void WriteBytes(const std::wstring& path, const std::string& bytes) {
    HANDLE file = CreateFileW(path.c_str(), GENERIC_WRITE, 0, nullptr, CREATE_ALWAYS, 0, nullptr);
    assert(file != INVALID_HANDLE_VALUE);
    DWORD written = 0;
    const BOOL wrote = WriteFile(file, bytes.data(), static_cast<DWORD>(bytes.size()), &written, nullptr);
    assert(wrote);
    CloseHandle(file);
}

int wmain() {
    using namespace extract_report;

    // Result codes distinguish 7-Zip's own exit codes, Win32 failures around its process, and raw crash statuses.
    assert(DescribeResult(2) == L"7-Zip exit code 2 (fatal error)");
    assert(DescribeResult(9) == L"7-Zip exit code 9 (unexpected exit code)");
    assert(DescribeResult(-5).rfind(L"Windows error 5 while running 7-Zip", 0) == 0);
    assert(Contains(DescribeResult(-ERROR_FILE_NOT_FOUND), L"Windows error 2"));
    assert(DescribeResult(static_cast<int>(0xC0000005)) == L"7-Zip terminated with status 0xC0000005");
    assert(DescribeResult(1000) == L"7-Zip terminated with status 0x000003E8");

    // The headline prefers the line naming the failing operation; the archive path 7-Zip echoes first is skipped
    // even when it contains spaces.
    const std::wstring spacedArchive = L"C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\nsa1F2C.tmp\\app-64.7z";
    const std::wstring broken = L"ERROR: " + spacedArchive + L"\r\napp-64.7z\r\nOpen ERROR: Cannot open the file as [7z] archive\r\n\r\n\r\nERRORS:\r\nIs not archive\r\n";
    assert(Headline(2, broken, spacedArchive) == L"Open ERROR: Cannot open the file as [7z] archive");
    assert(Headline(2, L"ERROR: app-64.7z\r\nOpen ERROR: Is not archive\r\n", spacedArchive) == L"Open ERROR: Is not archive");
    const std::wstring locked = L"ERROR: Cannot delete output file : The process cannot access the file. : C:\\Apps\\Harness.new-1\\resources\\app.node\r\n";
    assert(Headline(2, locked, spacedArchive) == Trim(locked));
    assert(Headline(2, L"ERROR: " + spacedArchive + L"\r\n" + locked, spacedArchive) == Trim(locked));
    assert(Headline(-ERROR_ACCESS_DENIED, L"", spacedArchive) == DescribeResult(-ERROR_ACCESS_DENIED));
    assert(Headline(2, L"ERROR: " + spacedArchive + L"\r\n", spacedArchive) == DescribeResult(2));
    assert(Headline(1, L"ERROR: only a note\r\n", spacedArchive) == L"ERROR: only a note");
    const std::wstring longLine = L"ERROR: Cannot open output file : " + std::wstring(400, L'x');
    const std::wstring headline = Headline(2, longLine, spacedArchive);
    assert(headline.size() == kHeadlineLimit && headline.back() == kEllipsis);

    // The report carries the result, both paths, and 7-Zip's output verbatim.
    const std::wstring report = Compose(2, L"C:\\Temp\\app-64.7z", L"C:\\Apps\\Harness.new-1", locked, L"2026-09-22 10:59:49", L"10.0.26100");
    assert(Contains(report, L"Result: 7-Zip exit code 2 (fatal error)\r\n"));
    assert(Contains(report, L"Archive: C:\\Temp\\app-64.7z\r\n"));
    assert(Contains(report, L"Destination: C:\\Apps\\Harness.new-1\r\n"));
    assert(Contains(report, L"Windows: 10.0.26100\r\n"));
    assert(Contains(report, L"\r\n7-Zip output:\r\n" + Trim(locked) + L"\r\n"));
    assert(Contains(Compose(2, L"a", L"b", L"   \r\n", L"t", L"w"), L"7-Zip output:\r\n(none)\r\n"));

    // The excerpt shows the result and 7-Zip's own lines, bounded by lines and characters, and counts what it left out.
    std::wstring manyErrors;
    for (int i = 0; i < 40; ++i) manyErrors += L"ERROR: Cannot open output file : Access is denied. : C:\\Apps\\file" + std::to_wstring(i) + L".dll\r\n";
    const std::wstring excerpt = Excerpt(Compose(2, L"a", L"b", manyErrors, L"t", L"w"));
    const std::vector<std::wstring> excerptLines = Lines(excerpt);
    assert(excerptLines.size() == kExcerptLines + 1);
    assert(excerptLines[0] == L"Result: 7-Zip exit code 2 (fatal error)");
    assert(excerptLines[1].rfind(L"ERROR: Cannot open output file", 0) == 0);
    assert(excerpt.size() <= kExcerptChars + 64);
    assert(Contains(excerpt, L" (" + std::to_wstring(41 - kExcerptLines) + L" more lines in the saved report)"));
    assert(!Contains(excerpt, L"Archive: "));
    assert(Excerpt(Compose(2, L"a", L"b", L"one\r\ntwo", L"t", L"w")) == L"Result: 7-Zip exit code 2 (fatal error)\r\none\r\ntwo");
    assert(Excerpt(Compose(2, L"a", L"b", std::wstring(2000, L'x'), L"t", L"w")).size() < 64 + kExcerptLineLimit + 64);

    // A cut inside a multi-byte sequence is trimmed back to a code point boundary.
    std::string partial("abc\xE6\x96\x87\xE4\xBB");
    TrimPartialUtf8(partial);
    assert(partial == "abc\xE6\x96\x87");
    std::string complete("abc\xE6\x96\x87");
    TrimPartialUtf8(complete);
    assert(complete == "abc\xE6\x96\x87");
    std::string ascii("abc");
    TrimPartialUtf8(ascii);
    assert(ascii == "abc");

    // 7-Zip output arrives as UTF-8; anything else falls back to the system code page instead of vanishing.
    assert(Decode("Access denied: \xE6\x96\x87\xE4\xBB\xB6") == L"Access denied: \x6587\x4EF6");
    assert(!Decode("\xC1\xED\xD2\xBB : file").empty());
    assert(Decode("") == L"");

    // The exported entry point writes the report beside a missing directory and survives a missing log file.
    WCHAR temp[MAX_PATH];
    const DWORD tempLength = GetTempPathW(MAX_PATH, temp);
    assert(tempLength);
    const std::wstring root = std::wstring(temp) + L"dsh-extract-report-" + std::to_wstring(GetCurrentProcessId());
    const BOOL created = CreateDirectoryW(root.c_str(), nullptr);
    assert(created);
    const std::wstring log = root + L"\\extract.log";
    WriteBytes(log, "ERROR: Cannot open output file : Access is denied. : C:\\Apps\\Harness.new-1\\\xE6\x96\x87\xE4\xBB\xB6.dll\r\n");
    const std::wstring reportPath = root + L"\\nested\\logs\\extract-failure.log";
    const int written = InstallerReportExtractFailure(nullptr, 2, L"C:\\Temp\\app-64.7z", L"C:\\Apps\\Harness.new-1", log.c_str(), reportPath.c_str(), 0,
        L"title", L"heading", L"hint", L"copy", L"expand", L"collapse", L"saved %s", L"unsaved", L"copied");
    assert(written == 1);
    const std::string saved = ReadBytes(reportPath);
    assert(saved.rfind("\xEF\xBB\xBF", 0) == 0);
    assert(saved.find("Result: 7-Zip exit code 2 (fatal error)") != std::string::npos);
    assert(saved.find("Access is denied. : C:\\Apps\\Harness.new-1\\\xE6\x96\x87\xE4\xBB\xB6.dll") != std::string::npos);
    const std::wstring missingLogReport = root + L"\\missing.log.txt";
    const int withoutLog = InstallerReportExtractFailure(nullptr, -ERROR_ACCESS_DENIED, L"a", L"b", (root + L"\\absent.log").c_str(), missingLogReport.c_str(), 0,
        L"title", L"heading", L"hint", L"copy", L"expand", L"collapse", L"saved %s", L"unsaved", L"copied");
    assert(withoutLog == 1);
    assert(ReadBytes(missingLogReport).find("Windows error 5 while running 7-Zip") != std::string::npos);
    assert(ReadBytes(missingLogReport).find("7-Zip output:\r\n(none)") != std::string::npos);
    // An unwritable report location reports failure without throwing.
    const int unwritable = InstallerReportExtractFailure(nullptr, 2, L"a", L"b", log.c_str(), (log + L"\\impossible.txt").c_str(), 0,
        L"title", L"heading", L"hint", L"copy", L"expand", L"collapse", L"saved %s", L"unsaved", L"copied");
    assert(unwritable == 0);

    for (const std::wstring& file : {reportPath, missingLogReport, log}) DeleteFileW(file.c_str());
    RemoveDirectoryW((root + L"\\nested\\logs").c_str());
    RemoveDirectoryW((root + L"\\nested").c_str());
    const BOOL removed = RemoveDirectoryW(root.c_str());
    assert(removed);
    return 0;
}
