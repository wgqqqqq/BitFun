#if DEBUG && targetEnvironment(simulator)
import OpenBitFunMobileCore
import SwiftUI
import WebKit

/// Dedicated simulator fixture only. Generated source, ephemeral loopback token,
/// no account store, screen capture, input provider or production credentials.
@MainActor
final class RemoteDesktopMediaProbe: ObservableObject {
    @Published var receiver: RemoteDesktopReceiver?
    @Published var stage = "starting"
    @Published var path = "unknown"
    @Published var permission = "untested"
    private var token = UUID()
    private let environment = ProcessInfo.processInfo.environment
    private var sourceStarted = false

    func open() {
        guard receiver == nil else { return }
        let stamp = UUID(); token = stamp
        let native = RemoteDesktopReceiver(prepared: { [weak self] in
            Task { await self?.start(stamp) }
        }, intent: { [weak self] event in
            guard let self, self.token == stamp else { return }
            if let answer = event as? RemoteDesktopMediaIntentAnswer {
                Task { _ = try? await self.operation(["operation": "answer", "sdp": answer.sdp]) }
            } else if event is RemoteDesktopMediaIntentFramePresented { self.stage = "presented" }
            else if let health = event as? RemoteDesktopMediaIntentHealth { self.path = "\(health.localCandidate)/\(health.remoteCandidate)" }
            else if event is RemoteDesktopMediaIntentFailed || event is RemoteDesktopMediaIntentUnavailable { self.stage = "failed" }
        })
        receiver = native
        native.view.accessibilityIdentifier = "rd-probe-media"
    }
    private func start(_ stamp: UUID) async {
        guard token == stamp, !sourceStarted else { return }
        sourceStarted = true
        do {
            let value = try await operation(["operation": "start", "id": "first"])
            guard token == stamp, let receiver else { return }
            guard let renderer = value["renderer_id"] as? String, let attachment = value["attach_id"] as? String,
                  let connection = value["connection_id"] as? String, let offer = value["offer_sdp"] as? String,
                  let servers = value["ice_servers"] as? [[String: Any]] else { stage = "failed"; return }
            let ice = servers.compactMap { server -> RemoteDesktopIceServerUi? in
                guard let urls = server["urls"] as? [String], let username = server["username"] as? String,
                      let credential = server["credential"] as? String else { return nil }
                return RemoteDesktopIceServerUi(urls: urls, username: username, credential: credential)
            }
            stage = "connecting"
            receiver.render(RemoteDesktopMediaUiState(rendererId: renderer, attachmentId: attachment, connectionId: connection,
                offerSdp: offer, iceServers: ice, forceRelay: value["force_relay"] as? Bool == true,
                sourceReady: true, signalingInterrupted: false, controlSupported: false))
        } catch { if token == stamp { stage = "failed" } }
    }
    private func operation(_ object: [String: Any]) async throws -> [String: Any] {
        guard let text = environment["OPENBITFUN_RD_PROBE_PORT"], let port = Int(text), (1024...65535).contains(port),
              let key = environment["OPENBITFUN_RD_PROBE_KEY"], key.count == 64, key.allSatisfy({ $0.isHexDigit }),
              let url = URL(string: "http://127.0.0.1:\(port)/operation") else { throw ProbeFailure.invalid }
        var request = URLRequest(url: url); request.httpMethod = "POST"; request.timeoutInterval = 20
        request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: object)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200, data.count <= 128 * 1024,
              let value = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ProbeFailure.invalid }
        return value
    }
    private enum ProbeFailure: Error { case invalid }
    func denyPermission() {
        receiver?.view.callAsyncJavaScript("if(typeof navigator.mediaDevices?.getUserMedia!=='function')return false;try{const s=await navigator.mediaDevices.getUserMedia({video:true,audio:true});s.getTracks().forEach(t=>t.stop());return false}catch{return true}", arguments: [:], in: nil, in: .page) { [weak self] result in
            if case let .success(value) = result, value as? Bool == true { self?.permission = "denied" }
            else { self?.permission = "failed" }
        }
    }

    func navigate() { receiver?.view.load(URLRequest(url: URL(string: "https://remote-desktop.invalid/blocked")!)) }
    func close() {
        token = UUID(); receiver?.close(); receiver = nil; stage = "stopped"
        Task { _ = try? await operation(["operation": "stop"]) }
    }
}

struct RemoteDesktopMediaProbeView: View {
    @StateObject private var model = RemoteDesktopMediaProbe()
    var body: some View {
        VStack {
            Text(model.stage).accessibilityIdentifier("rd-probe-stage")
            Text(model.path).accessibilityIdentifier("rd-probe-path")
            Text(model.permission).accessibilityIdentifier("rd-probe-permission")
            if let native = model.receiver { ProbeRenderer(native: native).frame(maxWidth: .infinity, maxHeight: .infinity) }
            HStack {
                Button("Stop") { model.close() }
                Button("Deny permission") { model.denyPermission() }
                Button("Navigate") { model.navigate() }
            }
        }.onAppear { model.open() }.onDisappear { model.close() }
    }
    private struct ProbeRenderer: UIViewRepresentable {
        let native: RemoteDesktopReceiver
        func makeUIView(context: Context) -> WKWebView { native.view }
        func updateUIView(_ view: WKWebView, context: Context) {}
        static func dismantleUIView(_ view: WKWebView, coordinator: ()) {}
    }
}
/// Layout-only states: no store, credentials, WebView or attachment.
struct RemoteDesktopLayoutProbeView: View {
    @State private var relay = false
    @State private var paused = true
    @State private var selected = false
    @State private var controls = false
    @State private var controlling = false
    @State private var keyboardOpen = false
    private let displays = (0..<12).map { RemoteDesktopDisplayUi(id: "display-\($0)", width: 1920, height: 1080) }
    var body: some View {
        RemoteDesktopPage(targetName: "Fixture computer", state: controls ?
            RemoteDesktopSetupUiStateViewing(display: displays[0], width: 1920, height: 1080, sourceLifecycleSupported: true) : selected ? RemoteDesktopSetupUiStateClosed.shared :
            paused ? RemoteDesktopSetupUiStateChoosePausedDisplay(display: displays[0], displays: displays) :
            RemoteDesktopSetupUiStateChooseDisplay(displays: displays), forceRelay: $relay,
            dispatch: { intent in
                if intent is RemoteDesktopSetupIntentCancelDisplayChange { paused = false }
                else { selected = true }
            }, close: { selected = true }, reconnect: { selected = false },
            control: controls ? RemoteDesktopControlUiState(binding: nil, supported: true, mode: controlling ? .controlling : .viewing,
                generation: nil, intentEpoch: 0, releasePending: false, failure: nil, textSupported: true) : nil,
            toggleControl: { controlling.toggle() }, keyboardOpen: keyboardOpen, toggleKeyboard: { keyboardOpen.toggle() }) { EmptyView() }
            .overlay(alignment: .bottomTrailing) {
                if !controls { Button("Layout controls") { controls = true }.accessibilityIdentifier("rd-layout-controls").padding(12) }
            }
    }
}
#endif
