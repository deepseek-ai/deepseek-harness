// Temporary clipboard contents are restored only while this transaction still owns them.
import AppKit
import Foundation

private final class PasteDataProvider: NSObject, NSPasteboardItemDataProvider, @unchecked Sendable {
    private enum Delivery { case pending, supplied, failed, closed }
    private let data: Data
    private let type: NSPasteboard.PasteboardType
    // AppKit can request promised data on another thread while the AX worker waits.
    private let condition = NSCondition()
    private var delivery: Delivery = .pending
    init(data: Data, type: NSPasteboard.PasteboardType) { self.data = data; self.type = type }
    func pasteboard(_ pasteboard: NSPasteboard?, item: NSPasteboardItem, provideDataForType type: NSPasteboard.PasteboardType) {
        condition.lock()
        defer { condition.unlock() }
        guard case .pending = delivery else { return }
        let supplied = type == self.type && item.setData(data, forType: type)
        delivery = supplied ? .supplied : .failed
    }
    func close() { condition.withLock { delivery = .closed } }
    @MainActor func wait(timeout: Duration, check: () throws -> Void) async throws {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while true {
            try check()
            let state = condition.withLock {
                if case .pending = delivery, clock.now >= deadline { delivery = .closed }
                return delivery
            }
            switch state {
            case .supplied: return
            case .failed: throw NativeFailure(code: "CLIPBOARD_UNAVAILABLE", message: "Requested paste data could not be supplied")
            case .closed: throw NativeFailure(code: "PASTE_NOT_CONSUMED", message:
                "Paste command was dispatched, but clipboard data was not requested within the read deadline. " +
                "Bring the target app to the foreground and focus its text input. Inspect the contents before deciding " +
                "whether to retry; a delayed paste may still run.")
            case .pending: try await clock.sleep(until: min(deadline, clock.now.advanced(by: .milliseconds(25))))
            }
        }
    }

}

@MainActor final class ClipboardPaste {
    private struct SavedItem: Sendable { let values: [(NSPasteboard.PasteboardType, Data)] }
    private static let ownerType = NSPasteboard.PasteboardType("org.deepseek-harness.cua.clipboard-owner")
    private let pasteboard: NSPasteboard
    private var restorePending: (() throws -> Void)?

    init(pasteboard: NSPasteboard = .general) { self.pasteboard = pasteboard }

    func perform(text: String, format: String, maxBytes: Int, readTimeout: Duration, checkCancellation: () throws -> Void = {},
                 operation: (@escaping @MainActor @Sendable () throws -> Void) async throws -> Void) async throws {
        try checkCancellation()
        let type: NSPasteboard.PasteboardType
        switch format {
        case "text": type = .string
        case "html": type = .html
        default: throw RequestParameters.invalid("Paste format must be text or html")
        }
        let data = Data(text.utf8)
        guard data.count <= maxBytes else { throw NativeFailure(code: "CLIPBOARD_LIMIT", message: "Paste data exceeds the configured clipboard byte limit") }
        let originalCount = pasteboard.changeCount
        let saved = try snapshot(maxBytes: maxBytes)
        let owner = Data(UUID().uuidString.utf8)
        let item = NSPasteboardItem()
        let provider = PasteDataProvider(data: data, type: type)
        defer { provider.close() }
        guard item.setDataProvider(provider, forTypes: [type]), item.setData(owner, forType: Self.ownerType) else {
            throw NativeFailure(code: "CLIPBOARD_UNAVAILABLE", message: "Could not prepare paste contents")
        }
        guard pasteboard.changeCount == originalCount else {
            throw NativeFailure(code: "CLIPBOARD_CHANGED", message: "Clipboard changed while preserving it; paste was not dispatched")
        }
        try checkCancellation()
        let cleared = pasteboard.clearContents()
        guard pasteboard.writeObjects([item]) else {
            if pasteboard.changeCount == cleared { try restore(saved) }
            throw NativeFailure(code: "CLIPBOARD_UNAVAILABLE", message: "Could not publish paste contents")
        }
        let expectedCount = pasteboard.changeCount
        let owned: @MainActor @Sendable () -> Bool = { [self] in
            pasteboard.changeCount == expectedCount && pasteboard.data(forType: Self.ownerType) == owner
        }
        let requireOwnership: @MainActor @Sendable () throws -> Void = {
            guard owned() else { throw NativeFailure(code: "CLIPBOARD_CHANGED", message: "Clipboard changed before paste; input was not dispatched") }
        }
        restorePending = { [self] in if owned() { try restore(saved) } }
        defer { restorePending = nil }
        do {
            try requireOwnership()
            try await operation(requireOwnership)
            try await provider.wait(timeout: readTimeout) { try checkCancellation(); try requireOwnership() }
        } catch {
            if owned() { try restore(saved) }
            throw error
        }
        if owned() { try restore(saved) }
    }

    func cancel() throws {
        try restorePending?()
        restorePending = nil
    }

    private func snapshot(maxBytes: Int) throws -> [SavedItem] {
        var total = 0
        return try (pasteboard.pasteboardItems ?? []).map { item in
            let values = try item.types.map { type -> (NSPasteboard.PasteboardType, Data) in
                guard let data = item.data(forType: type) else {
                    throw NativeFailure(code: "CLIPBOARD_UNAVAILABLE", message: "Existing clipboard formats could not be preserved")
                }
                guard data.count <= maxBytes - total else {
                    throw NativeFailure(code: "CLIPBOARD_LIMIT", message: "Existing clipboard exceeds the configured preservation byte limit")
                }
                total += data.count
                return (type, data)
            }
            return SavedItem(values: values)
        }
    }

    private func restore(_ saved: [SavedItem]) throws {
        let items = try saved.map { original -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in original.values {
                guard item.setData(data, forType: type) else {
                    throw NativeFailure(code: "CLIPBOARD_RESTORE_FAILED", message: "Could not reconstruct the original clipboard formats")
                }
            }
            return item
        }
        pasteboard.clearContents()
        if !items.isEmpty && !pasteboard.writeObjects(items) {
            throw NativeFailure(code: "CLIPBOARD_RESTORE_FAILED", message: "Could not restore the original clipboard contents")
        }
    }
}
