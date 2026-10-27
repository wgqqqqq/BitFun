import Foundation
import OpenBitFunMobileCore
import UIKit

@MainActor
protocol RemoteDesktopControlHost: AnyObject {
    var controlSnapshot: RemoteDesktopControlUiState { get }
    func controlIntent(_ value: RemoteDesktopControlIntent)
    func controlReport(_ value: RemoteDesktopControlReportIntent)
}

/// Native admission for one WK document. KMP owns intent admission; shared JS
/// owns wire leases/ACKs. Async WK replies are per-body admission points, not
/// cached permission grants; each opaque request is consumed once and expires.
@MainActor
final class RemoteDesktopControlBridge: NSObject, UIGestureRecognizerDelegate {
    private weak var host: (any RemoteDesktopControlHost)?
    private let execute: (String, [String: Any], @escaping (Bool?) -> Void) -> Void
    private let failed: () -> Void
    private let retired: (RemoteDesktopMediaBindingUi) -> Void
    private let ready: (RemoteDesktopMediaBindingUi) -> Void
    private var media: RemoteDesktopMediaUiState?
    private var frame = (Int32(0), Int32(0))
    private var focusObserved = false
    private var closed = false
    private(set) var focused = false
    var sdkSupported = false
    private var held: (RemoteDesktopControlUiState, CGSize, (Int32, Int32))?
    private var viewport = CGSize.zero
    private var previous: RemoteDesktopControlUiState?
    private var packets: [String: Packet] = [:]
    #if DEBUG && targetEnvironment(simulator)
    var pendingCount: Int { packets.count }
    #endif

    private final class Packet {
        let command: RemoteDesktopControlRendererIntent
        let action: String
        let generation: String
        let bodies: [[String: Any]]
        let deadline = ProcessInfo.processInfo.systemUptime + 2
        var next = 0
        var timeout: DispatchWorkItem?
        init(_ command: RemoteDesktopControlRendererIntent, _ action: String, _ generation: String, _ bodies: [[String: Any]]) {
            self.command = command; self.action = action; self.generation = generation; self.bodies = bodies
        }
    }
    init(host: any RemoteDesktopControlHost,
        execute: @escaping (String, [String: Any], @escaping (Bool?) -> Void) -> Void,
        retired: @escaping (RemoteDesktopMediaBindingUi) -> Void, ready: @escaping (RemoteDesktopMediaBindingUi) -> Void, failed: @escaping () -> Void) {
        self.host = host; self.execute = execute; self.retired = retired; self.ready = ready; self.failed = failed
    }
    private var binding: RemoteDesktopMediaBindingUi? {
        media.map { RemoteDesktopMediaBindingUi(rendererId: $0.rendererId, attachmentId: $0.attachmentId, connectionId: $0.connectionId) }
    }
    func render(_ value: RemoteDesktopMediaUiState?) {
        if value?.rendererId != media?.rendererId || value?.connectionId != media?.connectionId || value?.attachmentId != media?.attachmentId {
            held = nil; frame = (0, 0); focusObserved = false; previous = nil
        }
        media = value
        if value == nil || value?.signalingInterrupted == true { held = nil }
    }
    func geometry(_ width: Int32, _ height: Int32) {
        if frame != (width, height) { held = nil }
        frame = (width, height)
    }
    func viewportChanged(_ size: CGSize) { if viewport != size { held = nil }; viewport = size }
    func focusChanged(_ value: Bool) {
        guard !closed else { return }
        focused = value
        if !value {
            held = nil
            if let state = host?.controlSnapshot, let id = state.binding, id == binding {
                host?.controlIntent(RemoteDesktopControlIntentRelease(binding: id, intentEpoch: state.intentEpoch))
            }
        }
    }
    func focusDelivered(_ id: RemoteDesktopMediaBindingUi) {
        guard id == binding else { return }; focusObserved = true; reconcileReady()
    }
    func reconcileReady() {
        guard !closed, sdkSupported, focusObserved, frame.0 > 0, media?.controlSupported == true,
              let id = binding, let state = host?.controlSnapshot else { return }
        if state.binding != id || !state.supported { ready(id) }
    }
    func sync(_ state: RemoteDesktopControlUiState) {
        defer { previous = state }
        if let old = previous, old.binding != state.binding || old.intentEpoch != state.intentEpoch
            || old.generation != state.generation || old.mode != state.mode { held = nil }
        if let old = previous, let id = binding, old.binding == id, state.binding != id,
           old.mode != .viewing || old.releasePending { retired(id) }
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool {
        guard let view = gestureRecognizer.view, focused, let state = host?.controlSnapshot, state.binding == binding,
              state.mode == .controlling, media?.sourceReady == true, media?.signalingInterrupted == false else { held = nil; return true }
        held = (state, view.bounds.size, frame)
        return true
    }
    func gestureRecognizer(_ gestureRecognizer: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith otherGestureRecognizer: UIGestureRecognizer) -> Bool { true }
    @objc func tap(_ recognizer: UITapGestureRecognizer) {
        defer { held = nil }
        guard recognizer.state == .ended, recognizer.numberOfTouches <= 1, let view = recognizer.view,
              let original = held, original.1 == view.bounds.size, original.2 == frame, focused else { return }
        let p = recognizer.location(in: view)
        if let value = RemoteDesktopTapGeometryKt.remoteDesktopTapIntent(control: original.0,
            viewportWidth: Double(original.1.width), viewportHeight: Double(original.1.height), videoWidth: frame.0, videoHeight: frame.1,
            x: Double(p.x), y: Double(p.y)) { host?.controlIntent(value) }
    }

    private func permits(_ packet: Packet) -> Bool {
        guard !closed, sdkSupported, media?.controlSupported == true, let state = host?.controlSnapshot,
              state.supported, state.binding == binding, state.binding == packet.command.binding,
              state.intentEpoch == packet.command.intentEpoch else { return false }
        if packet.action == "release" { return state.mode == .viewing && state.releasePending }
        guard focused, media?.sourceReady == true, media?.signalingInterrupted == false else { return false }
        if packet.action == "acquire" { return state.mode == .acquiring }
        return state.mode == .controlling && state.generation == packet.generation
            && (packet.action != "text" || state.textSupported)
    }

    func command(_ command: RemoteDesktopControlRendererIntent) {
        guard !closed else { return }
        guard let packet = makePacket(command) else { failed(); return }
        guard permits(packet) else { skipped(command); return }
        guard packets.count < 8 else { failed(); return }
        let id = UUID().uuidString
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, self.packets.removeValue(forKey: id) != nil else { return }; self.failed()
        }
        packet.timeout = deadline; packets[id] = packet
        DispatchQueue.main.asyncAfter(deadline: .now() + 2, execute: deadline)
        let script = "return await window.OpenBitFunDesktopHost.runControl(id,count);"
        execute(script, ["id": id, "count": packet.bodies.count]) { [weak self] result in
            guard let self, !self.closed else { return }
            guard let pending = self.packets.removeValue(forKey: id) else { return }
            pending.timeout?.cancel()
            if result == nil { self.failed() }
            else if result == false { self.skipped(command) }
            else if pending.next != pending.bodies.count { self.failed() }
        }
    }
    /// Called only by the exact main-frame WK reply handler. No account/input
    /// payload comes from JS: it supplies an opaque ID and the next body index.
    func consume(_ request: Any) -> Any {
        guard !closed, let value = request as? [String: Any], Set(value.keys) == ["id", "index"],
              let id = value["id"] as? String, id.count == 36, let packet = packets[id],
              let index = value["index"] as? NSNumber, CFGetTypeID(index) != CFBooleanGetTypeID(),
              index.doubleValue.isFinite, index.doubleValue.rounded() == index.doubleValue,
              index.doubleValue >= 0, index.doubleValue < Double(packet.bodies.count),
              index.intValue == packet.next, packet.next < packet.bodies.count else { return false }
        guard ProcessInfo.processInfo.systemUptime < packet.deadline else {
            packets.removeValue(forKey: id); packet.timeout?.cancel(); failed(); return false
        }
        guard permits(packet) else { return false }
        let body = packet.bodies[packet.next]; packet.next += 1
        let bound = packet.command.binding
        return ["kind": "control", "renderer_id": bound.rendererId, "attach_id": bound.attachmentId,
            "connection_id": bound.connectionId, "control_epoch": String(packet.command.intentEpoch), "body": body] as [String: Any]
    }
    private func makePacket(_ c: RemoteDesktopControlRendererIntent) -> Packet? {
        if let a = c as? RemoteDesktopControlRendererIntentAcquire {
            return Packet(c, "acquire", "", [["kind": "acquire_control", "expected_state_revision": a.revision]])
        }
        if c is RemoteDesktopControlRendererIntentRelease { return Packet(c, "release", "", [["kind": "release_control"]]) }
        if let a = c as? RemoteDesktopControlRendererIntentTap {
            return Packet(c, "input", a.generation, [true, false].map { ["kind": "pointer_button", "control_generation": a.generation,
                "body": ["x": a.x, "y": a.y, "button": a.button.name.lowercased(), "down": $0]] })
        }
        if let a = c as? RemoteDesktopControlRendererIntentPointerMove {
            return Packet(c, "input", a.generation, [["kind": "pointer_move", "control_generation": a.generation, "body": ["x": a.x, "y": a.y]]])
        }
        if let a = c as? RemoteDesktopControlRendererIntentPointerButton {
            return Packet(c, "input", a.generation, [["kind": "pointer_button", "control_generation": a.generation,
                "body": ["x": a.x, "y": a.y, "button": a.button.name.lowercased(), "down": a.down]]])
        }
        if let a = c as? RemoteDesktopControlRendererIntentWheel {
            return Packet(c, "input", a.generation, [["kind": "wheel", "control_generation": a.generation,
                "body": ["x": a.x, "y": a.y, "dx": a.dx, "dy": a.dy]]])
        }
        if let a = c as? RemoteDesktopControlRendererIntentTextCommit {
            return Packet(c, "text", a.generation, [["kind": "text_commit", "control_generation": a.generation, "body": ["text": a.text]]])
        }
        if let a = c as? RemoteDesktopControlRendererIntentKeyTap {
            let usages = ["BACKSPACE": 0x2a, "DELETE": 0x4c, "ENTER": 0x28, "TAB": 0x2b, "ESCAPE": 0x29,
                "LEFT": 0x50, "RIGHT": 0x4f, "UP": 0x52, "DOWN": 0x51]
            guard let usage = usages[a.key.name] else { return nil }
            return Packet(c, "input", a.generation, [true, false].map { ["kind": "key", "control_generation": a.generation, "body": ["usage": usage, "down": $0]] })
        }
        return nil
    }
    private func skipped(_ command: RemoteDesktopControlRendererIntent) {
        guard let state = host?.controlSnapshot, state.binding == command.binding, state.intentEpoch == command.intentEpoch else { return }
        if command is RemoteDesktopControlRendererIntentAcquire {
            host?.controlReport(RemoteDesktopControlReportIntent(binding: command.binding, intentEpoch: command.intentEpoch,
                generation: nil, pending: nil, failure: .inputSuspended))
        } else if command is RemoteDesktopControlRendererIntentRelease { failed() }
        else { host?.controlIntent(RemoteDesktopControlIntentRelease(binding: command.binding, intentEpoch: command.intentEpoch)) }
    }
    func report(_ event: [String: Any], binding: RemoteDesktopMediaBindingUi) {
        guard let epochText = event["control_epoch"] as? String, let epoch = Int64(epochText), epoch >= 0, String(epoch) == epochText else { failed(); return }
        func optional(_ field: String) -> String? { event[field] is NSNull ? nil : event[field] as? String }
        for field in ["pending", "control_generation"] {
            if event[field] != nil && !(event[field] is NSNull) && !(event[field] is String) { failed(); return }
        }
        let pending: RemoteDesktopControlPending?
        switch optional("pending") {
        case nil: pending = nil
        case "acquire_control": pending = .acquire
        case "release_control": pending = .theRelease
        case "renew_control": pending = .renew
        default: failed(); return
        }
        let failure: RemoteDesktopControlFailure?
        switch event["code"] as? String {
        case "ok": failure = nil
        case "control_busy", "busy", "attachment_busy": failure = .busy
        case "device_approval_required", "authorization_required", "authorization_expired", "authorization_unknown": failure = .deviceApprovalRequired
        case "permission_required": failure = .permissionRequired
        case "stale_revision": failure = .staleRevision
        case "control_revoked": failure = .revoked
        case "input_suspended", "lease_expired", "stale_control": failure = .inputSuspended
        case "control_delivery_unknown", "input_backpressure": failure = .deliveryUnknown
        default: failure = .invalidResponse
        }
        host?.controlReport(RemoteDesktopControlReportIntent(binding: binding, intentEpoch: epoch,
            generation: optional("control_generation"), pending: pending, failure: failure))
    }
    func close() {
        closed = true; held = nil; media = nil; focused = false
        packets.values.forEach { $0.timeout?.cancel() }; packets.removeAll()
    }
}
