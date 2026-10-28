// Drag movement delays preserve sub-millisecond and unevenly divided budgets.
import Testing
@testable import CuaNative

@Test(arguments: [(1, 240), (399, 20), (400, 20)])
func dragMovementKeepsTheRequestedDuration(_ durationMs: Int, _ steps: Int) {
    let interval = WindowPointerInput.dragStepInterval(durationMs: durationMs, steps: steps)
    #expect(interval > 0)
    #expect(abs(interval * Double(steps) - Double(durationMs) / 1000) < 1e-12)
}
