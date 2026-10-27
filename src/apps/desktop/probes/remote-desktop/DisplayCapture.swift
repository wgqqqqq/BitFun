import AppKit
import ScreenCaptureKit
import CoreMedia
import CoreVideo

@_silgen_name("rd_probe_create")
func probeCreate(_ path: UnsafePointer<CChar>, _ codec: UnsafePointer<CChar>, _ relay: Bool, _ width: UInt32, _ height: UInt32) -> UnsafeMutableRawPointer?
@_silgen_name("rd_probe_push")
func probePush(_ handle: UnsafeMutableRawPointer, _ pixelBuffer: UnsafeMutableRawPointer, _ timestamp: Int64) -> Bool
@_silgen_name("rd_probe_stopped")
func probeStopped(_ handle: UnsafeMutableRawPointer) -> Bool
@_silgen_name("rd_probe_stop")
func probeStop(_ handle: UnsafeMutableRawPointer)

func log(_ text: String) { FileHandle.standardError.write(Data((text + "\n").utf8)) }
let arguments = CommandLine.arguments
func argument(_ name: String) -> String? {
    guard let i = arguments.firstIndex(of: name), i + 1 < arguments.count else { return nil }
    return arguments[i + 1]
}
if arguments.contains("--list-displays") {
    var displays = [CGDirectDisplayID](repeating: 0, count: 16); var count: UInt32 = 0
    CGGetActiveDisplayList(16, &displays, &count)
    for id in displays.prefix(Int(count)) { print("Display \(id): \(CGDisplayPixelsWide(id))x\(CGDisplayPixelsHigh(id)), main=\(id == CGMainDisplayID())") }
    exit(0)
}
guard argument("--config") != nil, let displayRaw = argument("--display-id"), UInt32(displayRaw) != nil else {
    log("Usage: native-display-probe --config PRIVATE_JSON --display-id ID [--codec H264|VP8] [--relay]"); exit(2)
}
let configPath = argument("--config")!
let displayID = UInt32(argument("--display-id")!)!
let codec = argument("--codec") ?? "H264"
guard ["H264", "VP8"].contains(codec) else { log("Unsupported codec"); exit(2) }
if arguments.contains("--engine-smoke") {
    let handle = configPath.withCString { path in codec.withCString { probeCreate(path, $0, true, 1280, 832) } }
    guard let handle else { log("Engine smoke creation failed"); exit(1) }
    Thread.sleep(forTimeInterval: 11)
    let stopped = probeStopped(handle); probeStop(handle)
    guard stopped else { log("No-native-frame gate did not stop engine"); exit(1) }
    log("Engine smoke passed: native factory created, no source pixels, gate stopped peer"); exit(0)
}

// A rendered native window covers the selected display during the fixture.
// SCStream captures that display's actual compositor pixels, not generated raw frames.
final class FixtureView: NSView {
    var status = "Ready — select Start native display capture"
    var frameCount: UInt64 = 0
    override func draw(_ dirtyRect: NSRect) {
        NSColor(calibratedRed: 0.05, green: 0.12, blue: 0.20, alpha: 1).setFill(); bounds.fill()
        let style: [NSAttributedString.Key: Any] = [.font: NSFont.monospacedSystemFont(ofSize: 32, weight: .medium), .foregroundColor: NSColor.white]
        let date = ISO8601DateFormatter().string(from: Date())
        let lines = ["OpenBitFun · native display probe", "ScreenCaptureKit → libwebrtc → ArkWeb", "Display \(displayID) · \(codec) · \(arguments.contains("--relay") ? "forced TURN" : "normal ICE")", date, status, "Captured complete frames: \(frameCount)", "60 second limit · no audio · no OS input"]
        for (i, text) in lines.enumerated() { text.draw(at: NSPoint(x: 70, y: bounds.height - 95 - CGFloat(i) * 60), withAttributes: style) }
        let t = Date().timeIntervalSince1970
        let bar = NSRect(x: 70, y: 110, width: max(10, (bounds.width - 140) * CGFloat(t.truncatingRemainder(dividingBy: 10) / 10)), height: 30)
        NSColor.systemGreen.setFill(); bar.fill()
        NSColor.systemRed.setFill(); NSRect(x: bounds.width - 150, y: 180, width: 60, height: 60).fill()
        NSColor.systemBlue.setFill(); NSRect(x: bounds.width - 220, y: 180, width: 60, height: 60).fill()
        NSColor.white.setFill(); NSRect(x: bounds.width - 290, y: 180, width: 60, height: 60).fill()
    }
}

final class DisplayProbe: NSObject, NSApplicationDelegate, SCStreamOutput, SCStreamDelegate, NSWindowDelegate, SCContentSharingPickerObserver {
    var window: NSWindow!
    let view = FixtureView()
    let captureQueue = DispatchQueue(label: "openbitfun.native-display-probe.capture")
    var handle: UnsafeMutableRawPointer? // Access only from captureQueue, including cleanup.
    var stream: SCStream?
    var timer: Timer?
    var started = false
    var closing = false
    var frames: UInt64 = 0
    var begin = Date()
    var startedCapture = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        guard let screen = NSScreen.screens.first(where: { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? UInt32) == displayID }) else { log("Selected display unavailable"); NSApp.terminate(nil); return }
        window = NSWindow(contentRect: screen.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        window.title = "OpenBitFun Native Display Probe"; window.contentView = view; window.delegate = self
        for (title, selector, x) in [("Start native display capture", #selector(start), 70.0), ("Stop and close", #selector(stop), 370.0)] {
            let button = NSButton(title: title, target: self, action: selector); button.frame = NSRect(x: x, y: 35, width: 280, height: 50); view.addSubview(button)
        }
        window.makeKeyAndOrderFront(nil); NSApp.activate(ignoringOtherApps: true)
        timer = Timer.scheduledTimer(withTimeInterval: 0.1, repeats: true) { [weak self] _ in
            guard let self else { return }; self.view.needsDisplay = true
            if self.started && !self.closing {
                let state = self.captureQueue.sync { self.handle.map { (true, probeStopped($0)) } ?? (false, false) }
                if state.1 || (state.0 && Date().timeIntervalSince(self.begin) >= 60) { self.stop() }
            }
        }
    }
    @objc func start() {
        guard !started && !closing else { return }
        if arguments.contains("--picker") {
            guard #available(macOS 15.2, *) else { view.status = "Picker identity check requires macOS 15.2+"; return }
            started = true
            var config = SCContentSharingPickerConfiguration()
            config.allowedPickerModes = [.singleDisplay]; config.allowsChangingSelectedContent = false
            let picker = SCContentSharingPicker.shared
            picker.defaultConfiguration = config; picker.add(self); picker.isActive = true
            picker.present(); view.status = "Select the explicit display in the macOS picker"
            return
        }
        guard CGPreflightScreenCaptureAccess() || CGRequestScreenCaptureAccess() else {
            view.status = "Screen Recording permission required; grant locally and restart"
            log("Native display authorization denied: no capture or engine started"); return
        }
        started = true; begin = Date(); window.level = .screenSaver
        Task { @MainActor in
            do {
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard !closing else { return }
                guard let display = content.displays.first(where: { $0.displayID == displayID }) else { throw NSError(domain: "SelectedDisplayUnavailable", code: 1) }
                try await startCapture(filter: SCContentFilter(display: display, excludingWindows: []), display: display)
            } catch {
                let e = error as NSError; log("Native display failed: domain=\(e.domain), code=\(e.code)")
                view.status = "Capture failed: \(e.domain) / \(e.code)"; stop()
            }
        }
    }
    func contentSharingPicker(_ picker: SCContentSharingPicker, didUpdateWith filter: SCContentFilter, for stream: SCStream?) {
        Task { @MainActor in
            guard !closing, stream == nil, self.stream == nil else { return }
            guard #available(macOS 15.2, *), filter.includedDisplays.count == 1, let display = filter.includedDisplays.first, display.displayID == displayID else {
                log("Picker selected an unexpected source; capture refused"); stop(); return
            }
            begin = Date(); window.level = .screenSaver
            do { try await startCapture(filter: filter, display: display) }
            catch { let e = error as NSError; log("Picker capture failed: domain=\(e.domain), code=\(e.code)"); stop() }
        }
    }
    func contentSharingPicker(_ picker: SCContentSharingPicker, didCancelFor stream: SCStream?) { DispatchQueue.main.async { self.stop() } }
    func contentSharingPickerStartDidFailWithError(_ error: Error) { log("System picker failed"); DispatchQueue.main.async { self.stop() } }
    @MainActor
    func startCapture(filter: SCContentFilter, display: SCDisplay) async throws {
                let width = 1280; let height = max(2, Int(Double(width) * Double(display.height) / Double(display.width)) / 2 * 2)
                let configuration = SCStreamConfiguration()
                configuration.width = width; configuration.height = height; configuration.minimumFrameInterval = CMTime(value: 1, timescale: 15)
                configuration.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
                configuration.queueDepth = 3; configuration.showsCursor = true; configuration.capturesAudio = false
                let created = configPath.withCString { path in codec.withCString { probeCreate(path, $0, arguments.contains("--relay"), UInt32(width), UInt32(height)) } }
                guard let created else { throw NSError(domain: "MediaEngineCreationFailed", code: 1) }
                captureQueue.sync { self.handle = created }
                let capture = SCStream(filter: filter, configuration: configuration, delegate: self); stream = capture
                try capture.addStreamOutput(self, type: .screen, sampleHandlerQueue: captureQueue)
                try await capture.startCapture()
                if closing { try? await capture.stopCapture(); return }
                startedCapture = true
                view.status = "Native capture running"; log("Native display started: id=\(displayID), source=\(display.width)x\(display.height), output=\(width)x\(height), pixelFormat=NV12, queueDepth=3")
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen, let handle, CMSampleBufferIsValid(sampleBuffer),
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let statusRaw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: statusRaw) == .complete,
              let buffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let time = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        guard time.isValid && time.isNumeric, time.seconds.isFinite && time.seconds >= 0 else { return }
        let timestamp = time.seconds
        let pointer = Unmanaged.passUnretained(buffer).toOpaque()
        _ = probePush(handle, pointer, Int64(timestamp * 1_000_000)); frames += 1
        let count = frames
        DispatchQueue.main.async { self.view.frameCount = count }
    }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        let e = error as NSError; log("Native stream stopped: domain=\(e.domain), code=\(e.code)"); DispatchQueue.main.async { self.stop() }
    }
    @objc func stop() {
        guard !closing else { return }; closing = true; timer?.invalidate()
        if arguments.contains("--picker") { SCContentSharingPicker.shared.remove(self); SCContentSharingPicker.shared.isActive = false }
        let retired = captureQueue.sync { let retired = handle; handle = nil; return retired }
        Task { @MainActor in
            if let stream { do { try await stream.stopCapture() } catch { log("Native stopCapture returned an error") } }
            self.stream = nil
            if let retired { probeStop(retired) }
            log("Native display cleanup complete: stream=closed, handle=released, frames=\(frames), duration=\(Date().timeIntervalSince(begin))")
            window.close(); NSApp.terminate(nil)
        }
    }
    func windowShouldClose(_ sender: NSWindow) -> Bool { stop(); return false }
}
let application = NSApplication.shared
application.setActivationPolicy(.regular)
let delegate = DisplayProbe(); application.delegate = delegate; application.run()
