// A nil entry preserves the position of an unreadable child without creating an actionable AX reference.
import ApplicationServices

struct AXObservedChildren {
    var entries: [AXUIElement?] = []
    var parentIncomplete = false

    var incomplete: Bool { parentIncomplete || entries.contains(nil) }
    static var unavailable: Self { Self(parentIncomplete: true) }

    enum RangeRead {
        case values([AXUIElement])
        case unreadable
        case unavailable
    }

    private static func smallerRanges(_ failed: Range<Int>) -> [Range<Int>] {
        if failed.count <= 5 { return failed.map { $0..<($0 + 1) } }
        let middle = failed.lowerBound + failed.count / 2
        return [failed.lowerBound..<middle, middle..<failed.upperBound]
    }

    /// A single observation shares its extra AX requests across all parents. Changed ranges lose their position guarantee.
    static func readRanges(count: Int, limit: Int, requests: inout Int,
                           read: (Range<Int>) throws -> RangeRead) rethrows -> Self {
        guard count > 0 else { return .unavailable }
        let end = min(count, limit)
        let prefix = 0..<end
        // The full list already failed. A shorter prefix imposed by the node limit has not been read.
        var pending = end < count ? [prefix] : Array(smallerRanges(prefix).reversed())
        var result = Self(parentIncomplete: end < count)
        while let range = pending.popLast() {
            guard requests > 0 else { result.parentIncomplete = true; break }
            requests -= 1
            switch try read(range) {
            case .values(let values):
                result.entries.append(contentsOf: values)
                if values.count == range.count { continue }
            case .unavailable:
                break
            case .unreadable:
                if range.count == 1 {
                    result.entries.append(nil)
                } else {
                    pending.append(contentsOf: smallerRanges(range).reversed())
                }
                continue
            }
            return Self(entries: result.entries.compactMap { $0 }, parentIncomplete: true)
        }
        return result
    }
}
