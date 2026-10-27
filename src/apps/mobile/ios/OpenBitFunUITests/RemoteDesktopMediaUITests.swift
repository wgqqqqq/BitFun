import XCTest
import CoreImage

final class RemoteDesktopMediaUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "com.openbitfun.mobile.ios")
    private var key = ""
    private var port = 0
    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let p = Int(env["OPENBITFUN_RD_PROBE_PORT"] ?? ""), (1024...65535).contains(p),
              let k = env["OPENBITFUN_RD_PROBE_KEY"], k.count == 64 else { throw XCTSkip("Use the dedicated iOS media runner.") }
        port = p; key = k
        app.launchArguments = ["--remote-desktop-media-probe"]
        app.launchEnvironment["OPENBITFUN_RD_PROBE_PORT"] = String(port)
        app.launchEnvironment["OPENBITFUN_RD_PROBE_KEY"] = key
        app.launch()
    }
    override func tearDownWithError() throws {
        _ = try? operation("stop")
        app.terminate()
    }
    private func wait(_ id: String, _ value: String, seconds: TimeInterval = 30) {
        let node = app.staticTexts[id]
        XCTAssertTrue(node.waitForExistence(timeout: 5))
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", value), object: node)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: seconds), .completed)
    }
    func testNativeVideoOrderedChannelAndStop() throws {
        wait("rd-probe-stage", "presented"); wait("rd-probe-path", "relay/relay")
        let end = Date().addingTimeInterval(8)
        var red = false, blue = false
        while Date() < end && !(red && blue) {
            let shot = app.screenshot().image
            guard let cg = shot.cgImage else { XCTFail("Missing native image"); return }
            let ci = CIImage(cgImage: cg)
            let sample = CGRect(x: ci.extent.midX, y: ci.extent.midY, width: 1, height: 1)
            var pixel = [UInt8](repeating: 0, count: 4)
            CIContext().render(ci, toBitmap: &pixel, rowBytes: 4, bounds: sample, format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
            red = red || pixel[0] > 150 && pixel[2] < 80
            blue = blue || pixel[2] > 150 && pixel[0] < 80
            RunLoop.current.run(until: Date().addingTimeInterval(0.12))
        }
        XCTAssertTrue(red && blue, "Native pixels must update through both generated colors")
        let stats = try operation("stats")
        XCTAssertTrue(["video/VP8", "video/H264"].contains(stats["codec"] as? String ?? ""))
        XCTAssertEqual(stats["candidate_type"] as? String, "relay")
        XCTAssertEqual(stats["remote_candidate_type"] as? String, "relay")
        _ = try operation("probe")
        var health: [String: Any] = [:]
        let deadline = Date().addingTimeInterval(5)
        repeat {
            health = try operation("status")
            if (health["health"] as? [String: Any])?["receiving"] as? Bool == true { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        } while Date() < deadline
        XCTAssertEqual((health["bound"] as? [String: Any])?["ordered"] as? Bool, true)
        XCTAssertEqual((health["bound"] as? [String: Any])?["matches"] as? Bool, true)
        XCTAssertEqual((health["health"] as? [String: Any])?["receiving"] as? Bool, true)
        XCTAssertEqual(health["unexpected_input"] as? Bool, false)
        let capture = XCTAttachment(screenshot: app.screenshot()); capture.name = "RemoteDesktopNativePixels"; capture.lifetime = .keepAlways; add(capture)
        app.buttons["Stop"].tap(); wait("rd-probe-stage", "stopped")
        XCTAssertEqual(try operation("status")["peer"] as? String, "closed")
    }
    func testMediaPermissionAndExternalNavigationAreRefused() throws {
        wait("rd-probe-stage", "presented"); wait("rd-probe-path", "relay/relay")
        app.buttons["Deny permission"].tap(); wait("rd-probe-permission", "denied", seconds: 8)
        app.buttons["Navigate"].tap(); wait("rd-probe-stage", "failed", seconds: 8)
        let deadline = Date().addingTimeInterval(5)
        var channel = "open"
        repeat {
            channel = try operation("status")["channel"] as? String ?? "unknown"
            if channel == "closed" { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.1))
        } while Date() < deadline
        XCTAssertEqual(channel, "closed", "The native receiver must close its channel before sender cleanup")
    }
    private func operation(_ name: String) throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/operation")!)
        request.httpMethod = "POST"; request.timeoutInterval = 8
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["operation": name])
        let done = expectation(description: "Fixture operation completed")
        var value: [String: Any]?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200, let data, data.count <= 128 * 1024 {
                value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return try XCTUnwrap(value, "Fixture operation unavailable")
    }
}

/// Native compact/wide chrome only; no account, host, renderer or input.
final class RemoteDesktopLayoutUITests: XCTestCase {
    func testPortraitAndLandscapeKeepCancelAndDisplayChoiceReachable() {
        continueAfterFailure = false
        let app = XCUIApplication(bundleIdentifier: "com.openbitfun.mobile.ios")
        defer { app.terminate(); XCUIDevice.shared.orientation = .portrait }
        for orientation in [UIDeviceOrientation.portrait, .landscapeLeft] {
            XCUIDevice.shared.orientation = orientation
            app.launchArguments = ["--remote-desktop-layout-probe"]
            app.launch()
            let cancel = app.buttons["remote-desktop-cancel"]
            XCTAssertTrue(cancel.waitForExistence(timeout: 10)); XCTAssertTrue(cancel.isHittable)
            let display = app.buttons["remote-desktop-display-0"]
            XCTAssertTrue(display.exists); XCTAssertTrue(display.isHittable)
            let landscape = orientation == .landscapeLeft
            let geometry = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                landscape ? app.frame.width > app.frame.height : app.frame.height > app.frame.width
            }, object: app)
            XCTAssertEqual(XCTWaiter.wait(for: [geometry], timeout: 5), .completed)
            XCTAssertTrue(app.frame.contains(cancel.frame)); XCTAssertTrue(app.frame.contains(display.frame))
            let screen = XCUIScreen.main.screenshot()
            let metadata = XCTAttachment(string: "app=\(app.frame) cancel=\(cancel.frame) screen=\(screen.image.size) orientation=\(screen.image.imageOrientation.rawValue)")
            metadata.name = "RemoteDesktopLayoutGeometry-\(orientation.rawValue)"; metadata.lifetime = .keepAlways; add(metadata)
            let capture = XCTAttachment(screenshot: screen); capture.name = "RemoteDesktopChoices-\(orientation.rawValue)"; capture.lifetime = .keepAlways; add(capture)
            cancel.tap(); XCTAssertFalse(cancel.exists)
            XCTAssertTrue(app.switches.firstMatch.exists)
            app.buttons["remote-desktop-display-0"].tap()
            XCTAssertTrue(app.buttons["remote-desktop-reconnect"].waitForExistence(timeout: 5))
            app.buttons["rd-layout-controls"].tap()
            let control = app.buttons["remote-desktop-control-toggle"]
            XCTAssertTrue(control.waitForExistence(timeout: 5)); XCTAssertTrue(control.isHittable)
            XCTAssertTrue(app.frame.contains(control.frame)); XCTAssertGreaterThanOrEqual(control.frame.height, 44)
            let prior = control.label; control.tap(); XCTAssertNotEqual(prior, control.label)
            app.buttons["remote-desktop-keyboard-toggle"].tap()
            let key = app.buttons["remote-desktop-key-TAB"]
            XCTAssertTrue(key.waitForExistence(timeout: 5)); XCTAssertTrue(key.isHittable)
            XCTAssertTrue(app.frame.contains(key.frame)); XCTAssertGreaterThanOrEqual(key.frame.height, 44)
            let dock = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); dock.name = "RemoteDesktopControlDock-\(orientation.rawValue)"; dock.lifetime = .keepAlways; add(dock)
            app.terminate()
        }
    }
}
