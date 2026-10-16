// Value-only membership decisions; these tests do not instantiate WindowSpaces or query WindowServer.
import Testing
@testable import CuaNative

@Test func checksEverySpaceAssignedToTheWindow() {
    let present = WindowSpaceMembership(spaceIDs: [2, 4, 8], currentSpaceID: 4)
    let absent = WindowSpaceMembership(spaceIDs: [2, 4, 8], currentSpaceID: 3)
    #expect(present.onCurrentSpace == true)
    #expect(absent.onCurrentSpace == false)
}

@Test func unavailableMembershipDoesNotBecomeAnotherSpace() {
    #expect(WindowSpaceMembership(spaceIDs: nil, currentSpaceID: 4).onCurrentSpace == nil)
    #expect(WindowSpaceMembership(spaceIDs: [4], currentSpaceID: nil).onCurrentSpace == nil)
    #expect(WindowSpaceMembership(spaceIDs: [], currentSpaceID: 4).onCurrentSpace == nil)
    #expect(WindowSpaceMembership(spaceIDs: [4], currentSpaceID: 0).onCurrentSpace == nil)
}

@Test func usesEachWindowsAssociatedDisplaySpace() {
    let primaryDisplay = WindowSpaceMembership(spaceIDs: [2], currentSpaceID: 2)
    let secondaryDisplay = WindowSpaceMembership(spaceIDs: [4], currentSpaceID: 4)
    let parkedOnSecondaryDisplay = WindowSpaceMembership(spaceIDs: [5], currentSpaceID: 4)
    #expect(primaryDisplay.onCurrentSpace == true)
    #expect(secondaryDisplay.onCurrentSpace == true)
    #expect(parkedOnSecondaryDisplay.onCurrentSpace == false)
}
