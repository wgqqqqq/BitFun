import XCTest
import CoreImage

/// Public iOS account factory -> encrypted rd-call -> product page/WKWebView.
/// Authentication and desktop are isolated fixtures; there is no OS input sink.
final class RemoteDesktopAccountUITests: XCTestCase {
    private let app = XCUIApplication(bundleIdentifier: "com.openbitfun.mobile.ios")
    private var key = ""
    private var port = 0
    override func setUpWithError() throws {
        continueAfterFailure = false
        let env = ProcessInfo.processInfo.environment
        guard let p = Int(env["OPENBITFUN_RD_PROBE_PORT"] ?? ""), (1024...65535).contains(p),
              let k = env["OPENBITFUN_RD_PROBE_KEY"], k.count == 64 else { throw XCTSkip("Use the dedicated iOS account runner.") }
        port = p; key = k
        app.launchArguments = ["--remote-desktop-account-probe", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launchEnvironment["OPENBITFUN_RD_PROBE_PORT"] = String(port)
        app.launchEnvironment["OPENBITFUN_RD_PROBE_KEY"] = key
    }
    override func tearDownWithError() throws {
        if (testRun?.failureCount ?? 0) > 0 {
            let back = app.buttons["rd-account-return-focus"]
            if back.exists && back.isHittable { back.tap() }
            let close = app.buttons["remote-desktop-close"]
            if close.exists && close.isHittable {
                close.tap(); _ = try? waitStatus({ $0["attachment"] as? Bool == false }, seconds: 5)
            }
        }
        app.terminate()
    }
    private func launch(allowView: Bool = true, control: Bool = false, grant: Bool = true, keyboard: Bool = false, pinyin: Bool = false) throws {
        _ = try operation("reset", ["allow_view": allowView, "control_supported": control, "control_grant": grant, "text_supported": keyboard, "actual_keyboard": keyboard && !pinyin])
        app.launch()
        waitLabel("rd-account-stage", "ready", seconds: 25)
        XCTAssertEqual(app.staticTexts["rd-account-chat-target"].label, "chat-target")
        app.buttons["rd-account-open"].tap()
    }
    private func selectDisplay() {
        let first = app.buttons["remote-desktop-display-0"]
        XCTAssertTrue(first.waitForExistence(timeout: 15))
        let relay = app.switches["remote-desktop-force-relay"]
        XCTAssertTrue(relay.exists)
        XCTAssertEqual(relay.value as? String, "0", "Initial relay policy must be explicit")
        relay.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == '1'"), object: relay)
        XCTAssertEqual(XCTWaiter.wait(for: [enabled], timeout: 5), .completed, "Relay toggle must update before selecting a display")
        first.tap()
    }
    private func pause() {
        app.buttons["remote-desktop-more"].tap()
        let action = app.buttons["Pause sharing"]
        XCTAssertTrue(action.waitForExistence(timeout: 5)); action.tap()
        XCTAssertTrue(app.buttons["remote-desktop-resume"].waitForExistence(timeout: 10))
    }
    private func waitLabel(_ id: String, _ value: String, seconds: TimeInterval = 10) {
        let node = app.staticTexts[id]
        XCTAssertTrue(node.waitForExistence(timeout: 5))
        let e = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == %@", value), object: node)
        XCTAssertEqual(XCTWaiter.wait(for: [e], timeout: seconds), .completed, "Expected closed fixture stage \(value)")
    }
    private func waitStatus(_ predicate: ([String: Any]) -> Bool, seconds: TimeInterval = 10) throws -> [String: Any] {
        let end = Date().addingTimeInterval(seconds)
        repeat {
            let value = try operation("status")
            XCTAssertEqual(value["errors"] as? Int, 0)
            if predicate(value) { return value }
            RunLoop.current.run(until: Date().addingTimeInterval(0.12))
        } while Date() < end
        XCTFail("Fixture status did not reach the required state")
        return [:]
    }
    private func attachment(_ status: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap((status["state"] as? [String: Any])?["attachment"] as? [String: Any])
    }
    private func source(_ status: [String: Any]) throws -> [String: Any] { try XCTUnwrap(status["source"] as? [String: Any]) }
    private func viewing(alternate: Bool = false) throws -> [String: Any] {
        let end = Date().addingTimeInterval(20)
        var first = false, second = false
        repeat {
            let image = XCUIScreen.main.screenshot().image
            if let cg = image.cgImage {
                let ci = CIImage(cgImage: cg)
                var pixel = [UInt8](repeating: 0, count: 4)
                CIContext().render(ci, toBitmap: &pixel, rowBytes: 4,
                    bounds: CGRect(x: ci.extent.midX, y: ci.extent.midY, width: 1, height: 1), format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())
                first = first || pixel[0] > 150 && pixel[2] < 80 && (!alternate || pixel[1] > 150)
                second = second || pixel[2] > 150 && pixel[0] < 80 && (!alternate || pixel[1] > 150)
            }
            if first && second { break }
            RunLoop.current.run(until: Date().addingTimeInterval(0.12))
        } while Date() < end
        if !(first && second) {
            let capture = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); capture.name = "MissingCurrentVideo"; capture.lifetime = .keepAlways; add(capture)
        }
        XCTAssertTrue(first && second, "Native video must present both current source colors")
        let status = try waitStatus { value in
            value["local"] as? String == "relay" && value["remote"] as? String == "relay"
                && ((value["state"] as? [String: Any])?["attachment"] as? [String: Any])?["phase"] as? String == "streaming"
        }
        let source = try source(status)
        XCTAssertEqual((source["bound"] as? [String: Any])?["matches"] as? Bool, true)
        XCTAssertEqual((source["bound"] as? [String: Any])?["ordered"] as? Bool, true)
        XCTAssertEqual(source["unexpected_input"] as? Bool, false)
        XCTAssertEqual((source["inputs"] as? [Any])?.count, 0)
        return status
    }
    private func exitAndSignOut() throws {
        app.buttons["remote-desktop-close"].tap()
        XCTAssertTrue(app.buttons["rd-account-open"].waitForExistence(timeout: 5))
        let detached = try waitStatus { $0["attachment"] as? Bool == false }
        XCTAssertEqual(detached["account_sockets"] as? Int, 1, "Closing the desktop must preserve the account socket")
        XCTAssertEqual(app.staticTexts["rd-account-chat-target"].label, "chat-target")
        app.buttons["rd-account-finish"].tap(); waitLabel("rd-account-stage", "signed_out")
    }
    func testAccountMediaAndCleanup() throws {
        try launch(); selectDisplay()
        let status = try viewing()
        XCTAssertEqual((status["counts"] as? [String: Any])?["attach"] as? Int, 1)
        let capture = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); capture.name = "AccountNativeVideo"; capture.lifetime = .keepAlways; add(capture)
        try exitAndSignOut()
        let ended = try operation("status")
        XCTAssertEqual((ended["counts"] as? [String: Any])?["detach"] as? Int, 1)
    }
    func testPauseDisplaySelectionAndExplicitFreshReconnect() throws {
        try launch(control: true); selectDisplay()
        let initial = try attachment(viewing())
        try enableControl(); pause()
        app.buttons["remote-desktop-changeDisplay"].tap()
        XCTAssertTrue(app.buttons["remote-desktop-cancel"].waitForExistence(timeout: 5))
        app.buttons["remote-desktop-cancel"].tap()
        XCTAssertTrue(app.buttons["remote-desktop-resume"].exists)
        app.buttons["remote-desktop-changeDisplay"].tap()
        app.buttons["remote-desktop-display-1"].tap()
        let changed = try viewing(alternate: true)
        let next = try attachment(changed)
        XCTAssertEqual(app.buttons["remote-desktop-control-toggle"].label, "Enable control")
        XCTAssertTrue((try source(changed))["lease"] is NSNull)
        XCTAssertEqual(initial["attach_id"] as? String, next["attach_id"] as? String)
        XCTAssertNotEqual(initial["connection_id"] as? String, next["connection_id"] as? String)
        XCTAssertEqual(next["display_id"] as? String, "fixture-other-display")
        XCTAssertEqual((changed["counts"] as? [String: Any])?["attach"] as? Int, 1)
        app.buttons["remote-desktop-close"].tap()
        _ = try waitStatus { $0["attachment"] as? Bool == false }
        app.buttons["rd-account-open"].tap()
        XCTAssertTrue(app.buttons["remote-desktop-display-0"].waitForExistence(timeout: 10))
        XCTAssertEqual((try operation("status")["counts"] as? [String: Any])?["attach"] as? Int, 1)
        selectDisplay()
        let reconnected = try attachment(viewing())
        XCTAssertNotEqual(initial["attach_id"] as? String, reconnected["attach_id"] as? String)
        try exitAndSignOut()
    }
    func testDeniedViewDoesNotEnumerateOrAllocateMedia() throws {
        try launch(allowView: false)
        let message = app.staticTexts["Approve this device on the computer first."]
        XCTAssertTrue(message.waitForExistence(timeout: 10))
        let status = try operation("status")
        let counts = try XCTUnwrap(status["counts"] as? [String: Any])
        for name in ["list_displays", "attach", "turn", "signal"] { XCTAssertEqual(counts[name] as? Int ?? 0, 0) }
        XCTAssertEqual(status["attachment"] as? Bool, false)
        try exitAndSignOut()
    }
    func testBackgroundClosesAndForegroundRequiresExplicitReconnect() throws {
        try launch(control: true); selectDisplay(); _ = try viewing(); try enableControl()
        XCUIDevice.shared.press(.home)
        _ = try waitStatus { $0["attachment"] as? Bool == false }
        app.activate()
        XCTAssertTrue(app.buttons["remote-desktop-reconnect"].waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["remote-desktop-display-0"].exists)
        XCTAssertEqual((try operation("status")["counts"] as? [String: Any])?["attach"] as? Int, 1)
        try exitAndSignOut()
    }
    private func enableControl() throws {
        let toggle = app.buttons["remote-desktop-control-toggle"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 10)); XCTAssertEqual(toggle.label, "Enable control")
        toggle.tap()
        _ = try waitStatus { ($0["source"] as? [String: Any])?["lease"] is String }
        let stopped = XCTNSPredicateExpectation(predicate: NSPredicate(format: "label == 'Stop control'"), object: toggle)
        XCTAssertEqual(XCTWaiter.wait(for: [stopped], timeout: 5), .completed)
    }
    private func tapMedia() {
        let media = app.webViews["remote-desktop-media"]
        XCTAssertTrue(media.waitForExistence(timeout: 5))
        media.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }
    func testExplicitControlTapPairsAndStop() throws {
        try launch(control: true); selectDisplay(); _ = try viewing()
        tapMedia()
        XCTAssertEqual((try source(operation("status"))["inputs"] as? [Any])?.count, 0)
        try enableControl()
        app.webViews["remote-desktop-media"].coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.95)).tap()
        XCTAssertEqual((try source(operation("status"))["inputs"] as? [Any])?.count, 0, "Letterboxing cannot emit input")
        tapMedia()
        let tapped = try source(waitStatus { (($0["source"] as? [String: Any])?["inputs"] as? [Any])?.count == 2 })
        let inputs = try XCTUnwrap(tapped["inputs"] as? [[String: Any]])
        XCTAssertEqual(inputs.map { $0["down"] as? Bool }, [true, false])
        for input in inputs {
            XCTAssertEqual(input["button"] as? String, "left")
            XCTAssertEqual(try XCTUnwrap(input["x"] as? Double), 0.5, accuracy: 0.02)
            XCTAssertEqual(try XCTUnwrap(input["y"] as? Double), 0.5, accuracy: 0.02)
        }
        XCTAssertEqual((tapped["held_buttons"] as? [Any])?.count, 0); XCTAssertEqual(tapped["unexpected_input"] as? Bool, false)
        app.buttons["rd-account-burst-taps"].tap()
        let burst = try source(waitStatus { (($0["source"] as? [String: Any])?["inputs"] as? [Any])?.count == 6 })
        XCTAssertEqual((burst["inputs"] as? [[String: Any]])?.map { $0["down"] as? Bool }, [true, false, true, false, true, false])
        XCTAssertEqual(burst["unexpected_input"] as? Bool, false)
        XCTAssertEqual((burst["held_buttons"] as? [Any])?.count, 0)
        let capture = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); capture.name = "NativeControlTap"; capture.lifetime = .keepAlways; add(capture)
        app.buttons["remote-desktop-control-toggle"].tap()
        _ = try waitStatus { (($0["source"] as? [String: Any])?["lease"]) is NSNull }
        tapMedia()
        XCTAssertEqual((try source(operation("status"))["inputs"] as? [Any])?.count, 6)
        try exitAndSignOut()
    }
    func testDeniedControlKeepsViewing() throws {
        try launch(control: true, grant: false); selectDisplay(); _ = try viewing()
        app.buttons["remote-desktop-control-toggle"].tap()
        let failure = app.staticTexts["remote-desktop-control-failure"]
        XCTAssertTrue(failure.waitForExistence(timeout: 8))
        XCTAssertEqual(failure.label, "Approve control on the computer first.")
        tapMedia(); let current = try source(operation("status"))
        XCTAssertEqual((current["inputs"] as? [Any])?.count, 0)
        XCTAssertEqual((current["control_counts"] as? [String: Any])?["acquire_control"] as? Int, 1)
        XCTAssertEqual(app.buttons["remote-desktop-control-toggle"].label, "Enable control")
        _ = try viewing()
        try exitAndSignOut()
    }
    func testQueuedTapRejectedAfterNativeWindowFocusLoss() throws {
        try launch(control: true); selectDisplay(); _ = try viewing(); try enableControl()
        app.buttons["rd-account-queue-focus"].tap()
        _ = try waitStatus { (($0["source"] as? [String: Any])?["lease"]) is NSNull }
        let before = try source(operation("status"))
        XCTAssertEqual((before["inputs"] as? [Any])?.count, 0)
        let back = app.buttons["rd-account-return-focus"]
        XCTAssertTrue(back.waitForExistence(timeout: 5)); back.tap()
        waitLabel("rd-account-queue-stage", "queued_before_focus_loss")
        XCTAssertEqual(app.buttons["remote-desktop-control-toggle"].label, "Enable control")
        tapMedia(); XCTAssertEqual((try source(operation("status"))["inputs"] as? [Any])?.count, 0)
        try exitAndSignOut()
    }
    func testNativeAdmissionRejectsStaleDuplicateAndExpiredRequests() throws {
        _ = try operation("reset", ["allow_view": true]); app.launch(); waitLabel("rd-account-stage", "ready", seconds: 25)
        app.buttons["rd-account-check-admission"].tap(); waitLabel("rd-account-admission", "passed")
        let counts = try operation("status")["counts"] as? [String: Any]
        XCTAssertEqual(counts?["attach"] as? Int ?? 0, 0)
        app.buttons["rd-account-finish"].tap(); waitLabel("rd-account-stage", "signed_out")
    }
    func testKeyboardPreeditAndRetirement() throws {
        _ = try operation("reset", ["allow_view": true]); app.launch(); waitLabel("rd-account-stage", "ready", seconds: 25)
        app.buttons["rd-account-check-keyboard"].tap(); waitLabel("rd-account-keyboard-check", "passed")
        app.buttons["rd-account-finish"].tap(); waitLabel("rd-account-stage", "signed_out")
    }
    func testNativeKeyboardCommitsDirectlyAndHidesOnStop() throws {
        XCUIDevice.shared.orientation = .portrait
        defer { XCUIDevice.shared.orientation = .portrait }
        try launch(control: true, keyboard: true); selectDisplay(); _ = try viewing(); try enableControl()
        let toggle = app.buttons["remote-desktop-keyboard-toggle"]
        XCTAssertTrue(toggle.exists); XCTAssertTrue(toggle.isEnabled); toggle.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 8))
        let introduction = app.buttons["Continue"]
        if introduction.waitForExistence(timeout: 4) { introduction.tap() }
        chooseKeyboard("English (US)")
        app.keys["h"].tap(); app.keys["i"].tap()
        _ = try waitStatus { (($0["source"] as? [String: Any])?["inputs"] as? [Any])?.count == 2 }
        app.buttons["remote-desktop-key-BACKSPACE"].coordinate(withNormalizedOffset: CGVector(dx: 0.1, dy: 0.1)).tap(); app.buttons["remote-desktop-key-ENTER"].tap()
        let current = try source(waitStatus { (($0["source"] as? [String: Any])?["inputs"] as? [Any])?.count == 6 })
        XCTAssertEqual(current["unexpected_input"] as? Bool, false)
        XCTAssertEqual((current["inputs"] as? [[String: Any]])?.filter { $0["kind"] as? String == "text_commit" }.count, 2)
        let before = try attachment(operation("status"))
        let portrait = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); portrait.name = "NativeKeyboardPortrait"; portrait.lifetime = .keepAlways; add(portrait)
        toggle.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        XCUIDevice.shared.orientation = .landscapeLeft
        let wide = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in self.app.frame.width > self.app.frame.height }, object: app)
        XCTAssertEqual(XCTWaiter.wait(for: [wide], timeout: 5), .completed)
        toggle.tap(); XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 8))
        let stop = app.buttons["remote-desktop-control-toggle"]
        XCTAssertTrue(stop.isHittable); XCTAssertTrue(app.frame.contains(stop.frame))
        XCTAssertTrue(app.buttons["remote-desktop-key-ENTER"].isHittable)
        let viewport = app.webViews["remote-desktop-media"]
        XCTAssertGreaterThanOrEqual(viewport.frame.height, (self.app.frame.height - app.keyboards.firstMatch.frame.height) * 0.5,
            "Compact keyboard chrome must leave at least half the available height for the desktop")
        let after = try attachment(operation("status"))
        XCTAssertEqual(before["attach_id"] as? String, after["attach_id"] as? String)
        XCTAssertEqual(before["connection_id"] as? String, after["connection_id"] as? String)
        let landscape = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); landscape.name = "NativeKeyboardLandscape"; landscape.lifetime = .keepAlways; add(landscape)
        stop.tap()
        _ = try waitStatus { (($0["source"] as? [String: Any])?["lease"]) is NSNull }
        let stopped = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [stopped], timeout: 5), .completed)
        XCTAssertFalse(app.buttons["remote-desktop-key-ENTER"].exists)
        XCTAssertFalse(toggle.isEnabled)
        XCTAssertEqual((try source(operation("status"))["inputs"] as? [Any])?.count, 6)
        try exitAndSignOut()
    }
    func testNativePinyinCandidateCommitAndDiscard() throws {
        try launch(control: true, keyboard: true, pinyin: true); selectDisplay(); _ = try viewing(); try enableControl()
        let toggle = app.buttons["remote-desktop-keyboard-toggle"]; toggle.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 8))
        let introduction = app.buttons["Continue"]
        if introduction.waitForExistence(timeout: 4) { introduction.tap() }
        chooseKeyboard("\u{7b80}\u{4f53}\u{62fc}\u{97f3}")
        for character in ["n", "i", "h", "a", "o", "x"] { app.keys[character].tap() }
        app.keys["delete"].tap()
        let candidate = app.descendants(matching: .any).matching(NSPredicate(format: "label == %@", "\u{4f60}\u{597d}")).firstMatch
        if !candidate.waitForExistence(timeout: 5) {
            let tree = XCTAttachment(string: app.keyboards.firstMatch.debugDescription); tree.name = "PinyinCandidateHierarchy"; tree.lifetime = .keepAlways; add(tree)
        }
        XCTAssertTrue(candidate.exists)
        let unconfirmed = try source(operation("status"))
        XCTAssertEqual((unconfirmed["inputs"] as? [Any])?.count, 0, "Preedit must remain local")
        let image = XCTAttachment(screenshot: XCUIScreen.main.screenshot()); image.name = "NativePinyinCandidate"; image.lifetime = .keepAlways; add(image)
        candidate.tap()
        let committed = try source(waitStatus { (($0["source"] as? [String: Any])?["inputs"] as? [Any])?.count == 1 })
        XCTAssertEqual(committed["unexpected_input"] as? Bool, false)
        XCTAssertEqual((committed["inputs"] as? [[String: Any]])?.first?["matches_expected"] as? Bool, true)
        app.keys["delete"].tap()
        let erased = try source(waitStatus { (($0["source"] as? [String: Any])?["inputs"] as? [Any])?.count == 3 })
        XCTAssertEqual(erased["unexpected_input"] as? Bool, false)
        app.keyboards.buttons["Return"].tap()
        _ = try waitStatus { (($0["source"] as? [String: Any])?["inputs"] as? [Any])?.count == 5 }
        for character in ["z", "a", "i"] { app.keys[character].tap() }
        app.keys["delete"].tap()
        XCTAssertEqual((try source(operation("status"))["inputs"] as? [Any])?.count, 5)
        toggle.tap()
        let hidden = XCTNSPredicateExpectation(predicate: NSPredicate(format: "exists == false"), object: app.keyboards.firstMatch)
        XCTAssertEqual(XCTWaiter.wait(for: [hidden], timeout: 5), .completed)
        XCTAssertEqual((try source(operation("status"))["inputs"] as? [Any])?.count, 5, "Hiding IME cannot confirm preedit")
        app.buttons["remote-desktop-control-toggle"].tap()
        _ = try waitStatus { (($0["source"] as? [String: Any])?["lease"]) is NSNull }
        try exitAndSignOut()
    }
    private func chooseKeyboard(_ name: String) {
        let globe = app.buttons["Next keyboard"]
        XCTAssertTrue(globe.waitForExistence(timeout: 5)); globe.press(forDuration: 1)
        let item = app.staticTexts[name]
        if !item.waitForExistence(timeout: 5) {
            let tree = XCTAttachment(string: app.debugDescription); tree.name = "MissingKeyboardPickerItem"; tree.lifetime = .keepAlways; add(tree)
        }
        XCTAssertTrue(item.exists); item.tap()
    }
    private func operation(_ name: String, _ body: [String: Any] = [:]) throws -> [String: Any] {
        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(port)/operation")!)
        request.httpMethod = "POST"; request.timeoutInterval = 8
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        var payload = body; payload["operation"] = name
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let done = expectation(description: "Fixture operation completed")
        var value: [String: Any]?
        URLSession.shared.dataTask(with: request) { data, response, _ in
            if (response as? HTTPURLResponse)?.statusCode == 200, let data, data.count <= 16 * 1024 {
                value = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            }
            done.fulfill()
        }.resume()
        wait(for: [done], timeout: 10)
        return try XCTUnwrap(value, "Fixture operation unavailable")
    }
}
