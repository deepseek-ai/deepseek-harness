// Range reads recover siblings when one child prevents macOS from returning the entire AXChildren array.
import ApplicationServices

struct AXObservedChildren {
    let elements: [AXUIElement]
    let incomplete: Bool

    static var unavailable: Self { Self(elements: [], incomplete: true) }

    enum RangeRead {
        case values([AXUIElement])
        case unreadable
        case unavailable
    }

    /// Requests are shared across the observation. A changed range invalidates this parent's accumulated indices.
    static func readRanges(count: Int, limit: Int, requests: inout Int,
                           read: (Range<Int>) throws -> RangeRead) rethrows -> Self {
        guard count > 0 else { return .unavailable }
        let end = min(count, limit)
        var pending = [0..<end]
        var children: [AXUIElement] = []
        var incomplete = end < count
        while let range = pending.popLast() {
            guard requests > 0 else { incomplete = true; break }
            requests -= 1
            switch try read(range) {
            case .values(let values):
                children.append(contentsOf: values)
            case .unavailable:
                return .unavailable
            case .unreadable:
                if range.count == 1 {
                    incomplete = true
                } else {
                    let middle = range.lowerBound + range.count / 2
                    pending.append(middle..<range.upperBound)
                    pending.append(range.lowerBound..<middle)
                }
            }
        }
        return Self(elements: children, incomplete: incomplete)
    }
}
