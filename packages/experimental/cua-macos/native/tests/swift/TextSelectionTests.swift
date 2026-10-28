// Literal selection disambiguation preserves UTF-16 positions without rewriting text.
import Foundation
import Testing
@testable import CuaNative

@Test func selectsOnlyTheRepeatedOccurrenceWithAdjacentContext() throws {
    let range = try TextSelection.range(in: "a😀 target / b😀 target", text: "target", prefix: "b😀 ", suffix: nil, mode: "text")
    #expect(range.location == 17)
    #expect(range.length == 6)
    let emoji = try TextSelection.range(in: "😀中😀中", text: "😀", prefix: "中", suffix: nil, mode: "text")
    #expect(emoji.location == 3)
    #expect(emoji.length == 2)
}

@Test func placesTheCursorBeforeOrAfterTheMatchedText() throws {
    let before = try TextSelection.range(in: "a😀 target / b😀 target", text: "target", prefix: "b😀 ", suffix: nil, mode: "cursor_before")
    let after = try TextSelection.range(in: "a😀 target / b😀 target", text: "target", prefix: "b😀 ", suffix: nil, mode: "cursor_after")
    #expect(before.location == 17 && before.length == 0)
    #expect(after.location == 23 && after.length == 0)
    let suffixed = try TextSelection.range(in: "target first; target second", text: "target", prefix: nil, suffix: " second", mode: "text")
    #expect(suffixed.location == 14 && suffixed.length == 6)
}

@Test(arguments: [("target target", "target", "AMBIGUOUS_TEXT"), ("aaaa", "aa", "AMBIGUOUS_TEXT"),
                  ("other", "target", "TEXT_NOT_FOUND"), ("", "target", "TEXT_NOT_FOUND")])
func rejectsMissingOrAmbiguousText(_ value: String, _ text: String, _ code: String) {
    do {
        _ = try TextSelection.range(in: value, text: text, prefix: nil, suffix: nil, mode: "text")
        Issue.record("Invalid selection was accepted")
    } catch let error as NativeFailure { #expect(error.code == code) }
    catch { Issue.record("Unexpected selection failure: \(error)") }
}

@Test func selectionContextIsAdjacentAndMatchingIsLiteral() throws {
    #expect(throws: NativeFailure.self) {
        try TextSelection.range(in: "prefix gap target", text: "target", prefix: "prefix", suffix: nil, mode: "text")
    }
    #expect(throws: NativeFailure.self) {
        try TextSelection.range(in: "e\u{301}", text: "é", prefix: nil, suffix: nil, mode: "text")
    }
    #expect(throws: NativeFailure.self) {
        try TextSelection.range(in: "hello", text: "", prefix: nil, suffix: nil, mode: "text")
    }
    #expect(throws: NativeFailure.self) {
        try TextSelection.range(in: "hello", text: "hello", prefix: nil, suffix: nil, mode: "unknown")
    }
}
