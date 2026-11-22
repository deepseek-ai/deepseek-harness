import Testing
@testable import CuaNative

@Test func aThumbnailIsNotAFullSizeWindow() {
    let full = WindowBounds(x: 221, y: 43, width: 1291, height: 849)
    let thumbnail = WindowBounds(x: 16, y: 435, width: 140, height: 145)
    #expect(!StageManagerShelf.matchesWindowSize(thumbnail, full))
    #expect(StageManagerShelf.matchesWindowSize(thumbnail, thumbnail))
    #expect(StageManagerShelf.matchesWindowSize(.init(x: 220, y: 42, width: 1292, height: 850), full))
}

@Test func aPileActionCanOnlyMoveAnAuthorizedWindow() {
    let owned: Set<UInt32> = [7, 8]
    #expect(StageManagerShelf.canAdd(7, members: [7], owned: owned, appScoped: false))
    #expect(StageManagerShelf.canAdd(7, members: [8, 7], owned: owned, appScoped: true))
    #expect(!StageManagerShelf.canAdd(7, members: [8, 7], owned: owned, appScoped: false))
    #expect(!StageManagerShelf.canAdd(7, members: [9, 7], owned: owned, appScoped: true))
    #expect(!StageManagerShelf.canAdd(9, members: [9], owned: owned, appScoped: false))
    #expect(!StageManagerShelf.canAdd(7, members: [8], owned: owned, appScoped: true))
}
