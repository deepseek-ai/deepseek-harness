// A nil entry preserves the position of an unreadable child without creating an actionable AX reference.
import ApplicationServices

/// Extra AX count/range calls and time spent in recovery, shared by all child lists in one request.
struct AXChildRecoveryBudget: Sendable {
    let limit: Int
    var requests: Int
    var time: Duration

    init(maxElements: Int, timeout: Float) {
        limit = maxElements
        requests = maxElements
        time = .seconds(Double(timeout))
    }
}

struct AXObservedChildren {
    var entries: [AXUIElement?] = []
    var parentIncomplete = false
    var elementLimitReached = false

    var hasUnreadableElements: Bool { parentIncomplete || entries.contains(nil) }
    var incomplete: Bool { hasUnreadableElements || elementLimitReached }
    static var unavailable: Self { Self(parentIncomplete: true) }

    enum RangeRead {
        case values([AXUIElement?])
        case unreadable
        case positionsUnknown
    }

    /// Read the current attribute before consulting any recovery result retained during window discovery.
    static func observing(_ read: () throws -> [AXUIElement], recover: () throws -> Self) throws -> Self {
        do { return try Self(entries: read()) }
        catch let error as NativeFailure where error.attribute == "AXChildren" && error.accessibilityError == AXError.failure.rawValue {
            return try recover()
        }
    }

    private static func smallerRanges(_ failed: Range<Int>) -> [Range<Int>] {
        if failed.count <= 5 { return failed.map { $0..<($0 + 1) } }
        let middle = failed.lowerBound + failed.count / 2
        return [failed.lowerBound..<middle, middle..<failed.upperBound]
    }

    /// A single request shares its extra AX requests across all parents. Changed ranges lose their position guarantee.
    static func readRanges(count: Int, limit: Int, requests: inout Int,
                           read: (Range<Int>) throws -> RangeRead) rethrows -> Self {
        guard count > 0 else { return Self() }
        guard limit > 0 else { return Self(elementLimitReached: true) }
        let end = min(count, limit)
        let prefix = 0..<end
        // The full list already failed. A shorter prefix imposed by the node limit has not been read.
        var pending = end < count ? [prefix] : Array(smallerRanges(prefix).reversed())
        var result = Self(elementLimitReached: end < count)
        while let range = pending.popLast() {
            guard requests > 0 else { result.parentIncomplete = true; break }
            requests -= 1
            switch try read(range) {
            case .values(let values):
                result.entries.append(contentsOf: values)
                if values.count == range.count { continue }
            case .positionsUnknown:
                break
            case .unreadable:
                if range.count == 1 {
                    result.entries.append(nil)
                } else {
                    pending.append(contentsOf: smallerRanges(range).reversed())
                }
                continue
            }
            return Self(entries: result.entries.compactMap { $0 }, parentIncomplete: true, elementLimitReached: result.elementLimitReached)
        }
        return result
    }
}
