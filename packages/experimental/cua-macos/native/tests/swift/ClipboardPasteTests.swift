// Each clipboard case owns a named pasteboard rather than touching the user's clipboard.
import AppKit
import ApplicationServices
import Foundation
import Testing
@testable import CuaNative

@Test @MainActor func clipboardPasteRestoresEveryOriginalFormatAfterDispatch() async throws {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    let item = NSPasteboardItem()
    let custom = NSPasteboard.PasteboardType("org.deepseek-harness.test.original")
    #expect(item.setString("original", forType: .string))
    #expect(item.setData(Data([1, 2, 3]), forType: custom))
    #expect(board.writeObjects([item]))
    try await ClipboardPaste(pasteboard: board).perform(text: "line 1\nline 2\tvalue", format: "text", maxBytes: 1024, readTimeout: .seconds(1)) { current in
        try current()
        #expect(board.string(forType: .string) == "line 1\nline 2\tvalue")
    }
    #expect(board.string(forType: .string) == "original")
    #expect(board.data(forType: custom) == Data([1, 2, 3]))
}

@Test @MainActor func clipboardPastePublishesHTMLWithoutTypingItsMarkup() async throws {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    let html = "<h1>Title</h1><p><b>Bold</b> <a href=\"https://example.com/\">link</a></p>"
    try await ClipboardPaste(pasteboard: board).perform(text: html, format: "html", maxBytes: 1024, readTimeout: .seconds(1)) { current in
        try current()
        #expect(board.data(forType: .html) == Data(html.utf8))
        #expect(board.string(forType: .string) == nil)
    }
    #expect(board.pasteboardItems?.isEmpty ?? true)
}

@Test @MainActor func clipboardPastePreservesANewerCopyInsteadOfRestoringOverIt() async throws {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    #expect(board.setString("original", forType: .string))
    do {
        try await ClipboardPaste(pasteboard: board).perform(text: "paste", format: "text", maxBytes: 1024, readTimeout: .seconds(1)) { current in
            board.clearContents()
            #expect(board.setString("new user copy", forType: .string))
            try current()
        }
        Issue.record("Changed clipboard was accepted")
    } catch let error as NativeFailure { #expect(error.code == "CLIPBOARD_CHANGED") }
    #expect(board.string(forType: .string) == "new user copy")
}

@Test @MainActor func clipboardPasteRestoresOnCancellationAndRejectsOversizedPreservationBeforeChangingData() async throws {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    #expect(board.setString("original", forType: .string))
    do {
        try await ClipboardPaste(pasteboard: board).perform(text: "paste", format: "text", maxBytes: 1024, readTimeout: .seconds(1)) { _ in
            throw NativeFailure(code: "NATIVE_CANCELLED", message: "fixture cancellation")
        }
        Issue.record("Cancelled operation succeeded")
    } catch let error as NativeFailure { #expect(error.code == "NATIVE_CANCELLED") }
    #expect(board.string(forType: .string) == "original")
    board.clearContents()
    let large = String(repeating: "x", count: 2048)
    #expect(board.setString(large, forType: .string))
    do {
        try await ClipboardPaste(pasteboard: board).perform(text: "paste", format: "text", maxBytes: 1024, readTimeout: .seconds(1)) { _ in
            Issue.record("Oversized clipboard reached dispatch")
        }
        Issue.record("Oversized clipboard was accepted")
    } catch let error as NativeFailure { #expect(error.code == "CLIPBOARD_LIMIT") }
    #expect(board.string(forType: .string) == large)
}

@Test @MainActor func clipboardPasteAwaitsDataConsumptionAndCanCancelBeforeItIsRequested() async throws {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    #expect(board.setString("original", forType: .string))
    var dispatched = false
    do {
        try await ClipboardPaste(pasteboard: board).perform(text: "paste", format: "text", maxBytes: 1024, readTimeout: .seconds(1),
            checkCancellation: { if dispatched { throw NativeFailure(code: "NATIVE_CANCELLED", message: "delivery cancelled") } }) { _ in
                dispatched = true
            }
        Issue.record("Unread clipboard data completed without cancellation")
    } catch let error as NativeFailure { #expect(error.code == "NATIVE_CANCELLED") }
    #expect(board.string(forType: .string) == "original")
}

@Test @MainActor func clipboardPasteReportsUnreadDataAfterDispatchAndRestoresOriginalContents() async throws {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    #expect(board.setString("original", forType: .string))
    var dispatched = false
    do {
        try await ClipboardPaste(pasteboard: board).perform(text: "paste", format: "text", maxBytes: 1024,
            readTimeout: .zero) { current in
                try current()
                dispatched = true
            }
        Issue.record("Unread paste completed successfully")
    } catch let error as NativeFailure {
        #expect(error.code == "PASTE_NOT_CONSUMED")
        #expect(error.message.contains("foreground"))
        #expect(error.message.contains("focus"))
        #expect(error.message.contains("Inspect"))
    }
    #expect(dispatched)
    #expect(board.string(forType: .string) == "original")
}

@Test @MainActor func clipboardPasteAcceptsAReadAfterDispatchBeforeTheDeadline() async throws {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    #expect(board.setString("original", forType: .string))
    var dispatched = false
    var consumed: String?
    try await ClipboardPaste(pasteboard: board).perform(text: "paste", format: "text", maxBytes: 1024,
        readTimeout: .seconds(1), checkCancellation: {
            if dispatched { consumed = board.string(forType: .string) }
        }) { _ in dispatched = true }
    #expect(consumed == "paste")
    #expect(board.string(forType: .string) == "original")
}

@Test @MainActor func clipboardPasteKeepsAnUnsupportedMenuFailureDistinctFromUnreadData() async throws {
    let board = NSPasteboard.withUniqueName()
    defer { board.releaseGlobally() }
    #expect(board.setString("original", forType: .string))
    do {
        try await ClipboardPaste(pasteboard: board).perform(text: "paste", format: "text", maxBytes: 1024,
            readTimeout: .zero) { _ in
                throw NativeFailure(code: "UNSUPPORTED", message: "No standard Paste command is available")
            }
        Issue.record("Unsupported Paste command completed successfully")
    } catch let error as NativeFailure { #expect(error.code == "UNSUPPORTED") }
    #expect(board.string(forType: .string) == "original")
}

/// Search and clipboard transaction run together. The synthetic menu owns no desktop input.
@Test @MainActor func pasteRequiresOneCommandAcrossAllRecoveredBranches() async throws {
    let root = AXUIElementCreateApplication(10)
    let first = AXUIElementCreateApplication(11)
    let other = AXUIElementCreateApplication(12)
    var requests = 2
    let restored = AXObservedChildren.readRanges(count: 2, limit: 2, requests: &requests) { range in
        .values(range.lowerBound == 0 ? [other] : [first])
    }
    let cases: [(AXObservedChildren, Set<AXUIElement>, String?)] = [
        (restored, [first], nil),
        (.init(entries: [other, first, first]), [first], nil),
        (.init(entries: [first, nil]), [first], "incomplete"),
        (.init(entries: [nil, first]), [first], "incomplete"),
        (.init(entries: [first, nil, other]), [first, other], "ambiguous"),
        (.init(entries: [first], parentIncomplete: true), [first], "incomplete"),
        (.init(entries: [first], elementLimitReached: true), [first], "incomplete"),
    ]
    for (list, commands, reason) in cases {
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        #expect(board.setString("original", forType: .string))
        var received: [AXUIElement] = []
        do {
            try await ClipboardPaste(pasteboard: board).perform(text: "payload", format: "text", maxBytes: 1024,
                readTimeout: .seconds(1)) { ownership in
                let command = try AXAccess.pasteCommand(in: root, maxElements: 10, maxDepth: 2,
                    matches: commands.contains, children: { $0 == root ? list : .init() })
                try ownership()
                received.append(command)
                #expect(board.string(forType: .string) == "payload")
            }
            #expect(reason == nil)
        } catch let error as NativeFailure {
            #expect(error.code == "UNSUPPORTED")
            #expect(error.message.contains(try #require(reason)))
            #expect(error.message.contains("No input was dispatched. Read fresh state"))
        }
        #expect(received == (reason == nil ? [first] : []))
        #expect(board.string(forType: .string) == "original")
    }
}

@Test func pasteTraversalLimitsApplyAfterFindingACandidate() {
    let root = AXUIElementCreateApplication(10), candidate = AXUIElementCreateApplication(11)
    let nested = AXUIElementCreateApplication(12)
    for (count, depth) in [(2, 5), (10, 1)] {
        do {
            _ = try AXAccess.pasteCommand(in: root, maxElements: count, maxDepth: depth, matches: { $0 == candidate }) {
                if $0 == root { return .init(entries: [candidate]) }
                return .init(entries: $0 == candidate ? [nested] : [])
            }
            Issue.record("A traversal limit hid a possible second Paste command")
        } catch let error as NativeFailure {
            #expect(error.code == "UNSUPPORTED")
            #expect(error.message.contains("No input was dispatched. Read fresh state"))
        } catch { Issue.record("Unexpected error: \(error)") }
    }
}
