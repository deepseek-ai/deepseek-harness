// The selected catalog entry must still identify the executable inspected for consent.
import Darwin
import Testing
@testable import CuaNative

@Test func rejectsAChangedExecutableBeforeProducingAnAuthorizationIdentity() throws {
    let identity = try NativePlatform.identity(getpid())
    do {
        _ = try ApplicationAuthorization.describe(identity, name: "Fixture", expectedExecutablePath: "/not/the/running/executable")
        Issue.record("A changed executable was accepted")
    } catch let error as NativeFailure {
        #expect(error.code == "STALE_APP")
    }
}

@Test func refusesApplicationConsentWithoutAnExecutableLocation() throws {
    let identity = try NativePlatform.identity(getpid())
    do {
        _ = try ApplicationAuthorization.describe(identity, name: "Fixture", expectedExecutablePath: nil)
        Issue.record("Missing executable metadata was accepted")
    } catch let error as NativeFailure {
        #expect(error.code == "APP_UNAVAILABLE")
    }
}
