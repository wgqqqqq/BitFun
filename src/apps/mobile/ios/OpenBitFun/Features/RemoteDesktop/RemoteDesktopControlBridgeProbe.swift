#if DEBUG && targetEnvironment(simulator)
import Foundation
import OpenBitFunMobileCore

/// Deterministic native-boundary checks; the executor holds JS before admission.
/// No socket, credentials, screen capture or OS input provider is involved.
@MainActor
enum RemoteDesktopControlBridgeProbe {
    private final class Host: RemoteDesktopControlHost {
        var controlSnapshot: RemoteDesktopControlUiState
        var releases = 0
        init(_ state: RemoteDesktopControlUiState) { controlSnapshot = state }
        func controlIntent(_ value: RemoteDesktopControlIntent) { if value is RemoteDesktopControlIntentRelease { releases += 1 } }
        func controlReport(_ value: RemoteDesktopControlReportIntent) {}
    }
    static func run() async -> Bool {
        let id = RemoteDesktopMediaBindingUi(rendererId: "renderer", attachmentId: "attachment", connectionId: "connection")
        func state(_ epoch: Int64 = 2, _ mode: RemoteDesktopControlMode = .controlling) -> RemoteDesktopControlUiState {
            RemoteDesktopControlUiState(binding: id, supported: true, mode: mode, generation: mode == .controlling ? "1" : nil,
                intentEpoch: epoch, releasePending: mode == .viewing, failure: nil, textSupported: false)
        }
        let host = Host(state())
        var failures = 0, retired = 0
        var arguments: [String: Any] = [:]
        var completion: ((Bool?) -> Void)?
        let bridge = RemoteDesktopControlBridge(host: host, execute: { _, args, done in arguments = args; completion = done },
            retired: { if $0 == id { retired += 1 } }, ready: { _ in }, failed: { failures += 1 })
        bridge.render(RemoteDesktopMediaUiState(rendererId: id.rendererId, attachmentId: id.attachmentId, connectionId: id.connectionId,
            offerSdp: "", iceServers: [], forceRelay: true, sourceReady: true, signalingInterrupted: false, controlSupported: true))
        bridge.sdkSupported = true; bridge.geometry(320, 180); bridge.focusChanged(true)
        let tap = RemoteDesktopControlRendererIntentTap(binding: id, intentEpoch: 2, generation: "1", x: 0.5, y: 0.5)
        func request(_ index: Any) -> [String: Any] { ["id": arguments["id"] ?? "", "index": index] }
        func denied(_ value: Any) -> Bool { value as? Bool == false }
        bridge.command(tap)
        guard arguments["count"] as? Int == 2,
              denied(bridge.consume(request(true))), denied(bridge.consume(request(1))),
              denied(bridge.consume(request(-1))), denied(bridge.consume(request(0.5))),
              denied(bridge.consume(request(1e30))),
              let first = bridge.consume(request(0)) as? [String: Any], first["control_epoch"] as? String == "2",
              denied(bridge.consume(request(0))),
              bridge.consume(request(1)) is [String: Any], denied(bridge.consume(request(2))) else { bridge.close(); return false }
        completion?(true)
        guard failures == 0 else { bridge.close(); return false }
        bridge.command(tap); host.controlSnapshot = state(3, .viewing)
        guard denied(bridge.consume(request(0))) else { bridge.close(); return false }
        completion?(false)
        guard host.releases == 0 else { bridge.close(); return false } // old epoch cannot release successor
        host.controlSnapshot = state(); bridge.command(tap); bridge.focusChanged(false)
        guard denied(bridge.consume(request(0))), host.releases == 1 else { bridge.close(); return false }
        completion?(false)
        bridge.focusChanged(true); bridge.sync(state())
        bridge.sync(RemoteDesktopControlUiState(binding: nil, supported: false, mode: .viewing, generation: nil,
            intentEpoch: 0, releasePending: false, failure: nil, textSupported: false))
        guard retired == 1 else { bridge.close(); return false }
        bridge.command(tap)
        try? await Task.sleep(nanoseconds: 2_200_000_000)
        guard failures == 1, denied(bridge.consume(request(0))) else { bridge.close(); return false }
        completion?(true) // late completion cannot resurrect expired admission
        guard failures == 1 else { bridge.close(); return false }
        for _ in 0..<8 { bridge.command(tap) }
        bridge.command(tap)
        guard failures == 2, bridge.pendingCount == 8 else { bridge.close(); return false }
        bridge.close()
        return denied(bridge.consume(request(0)))
    }
}

#endif
