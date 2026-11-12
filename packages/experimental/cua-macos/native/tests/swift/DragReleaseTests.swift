// Exercise release ownership without permission to move the desktop pointer.
import CoreGraphics
import Testing
@testable import CuaNative

@Test func systemDragRequiresAllSupportedButtonsToBeReleased() throws {
    try WindowPointerInput.requireReleasedButtons(isPressed: { _ in false })
    for held in [CGMouseButton.left, .right, .center] {
        do {
            try WindowPointerInput.requireReleasedButtons(isPressed: { $0 == held })
            Issue.record("Admitted drag while button was held")
        } catch let error as NativeFailure {
            #expect(error.code == "INPUT_BUSY")
        }
    }
}

@Test @MainActor func interruptedDragReleasesOnlyAtTheLastPostedPoint() async throws {
    func event(_ type: CGEventType, x: Int) throws -> CGEvent {
        try #require(CGEvent(mouseEventSource: nil, mouseType: type,
                             mouseCursorPosition: CGPoint(x: x, y: 10), mouseButton: .left))
    }
    let down = try event(.leftMouseDown, x: 10)
    let release = try event(.leftMouseUp, x: 10)
    let path = try [20, 30].map { x in
        WindowPointerInput.DragStep(movement: try event(.leftMouseDragged, x: x), release: try event(.leftMouseUp, x: x))
    }
    let interruptions: [(CGEvent, [CGEvent])] = [
        (down, []),
        (path[0].movement, [down, release]),
        (path[1].movement, [down, path[0].movement, path[0].release]),
    ]
    for (blocked, expected) in interruptions {
        let blockedType = blocked.type, blockedPoint = blocked.location
        var posted: [CGEvent] = []
        do {
            try await WindowPointerInput.postDrag(down: down, initialRelease: release, path: path, interval: 0,
                validate: { if $0 == blockedType && $1 == blockedPoint { throw CancellationError() } }, post: { posted.append($0) })
            Issue.record("Interrupted drag completed")
        } catch { #expect(error is CancellationError) }
        #expect(posted.elementsEqual(expected, by: { $0 === $1 }))
    }
}
