// Literal text matching returns UTF-16 ranges accepted by macOS accessibility.
import Foundation

struct TextSelection {
    static func range(in value: String, text: String, prefix: String?, suffix: String?, mode: String) throws -> CFRange {
        guard !text.isEmpty else { throw RequestParameters.invalid("Selection text must not be empty") }
        guard ["text", "cursor_before", "cursor_after"].contains(mode) else {
            throw RequestParameters.invalid("Unsupported text selection type")
        }
        let source = value as NSString
        let before = (prefix ?? "") as NSString
        let after = (suffix ?? "") as NSString
        var start = 0
        var match: NSRange?
        while start <= source.length {
            let candidate = source.range(of: text, options: .literal, range: NSRange(location: start, length: source.length - start))
            if candidate.location == NSNotFound { break }
            let end = candidate.location + candidate.length
            let matchesPrefix = candidate.location >= before.length
                && source.substring(with: NSRange(location: candidate.location - before.length, length: before.length)).utf16.elementsEqual((before as String).utf16)
            let matchesSuffix = source.length - end >= after.length
                && source.substring(with: NSRange(location: end, length: after.length)).utf16.elementsEqual((after as String).utf16)
            if matchesPrefix && matchesSuffix {
                guard match == nil else {
                    throw NativeFailure(code: "AMBIGUOUS_TEXT", message: "Text matches more than once; supply adjacent prefix or suffix")
                }
                match = candidate
            }
            start = candidate.location + 1
        }
        guard let match else { throw NativeFailure(code: "TEXT_NOT_FOUND", message: "Text and adjacent context were not found in this control") }
        switch mode {
        case "cursor_before": return CFRange(location: match.location, length: 0)
        case "cursor_after": return CFRange(location: match.location + match.length, length: 0)
        default: return CFRange(location: match.location, length: match.length)
        }
    }
}
