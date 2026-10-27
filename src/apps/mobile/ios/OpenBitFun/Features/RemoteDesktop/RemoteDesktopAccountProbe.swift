#if DEBUG && targetEnvironment(simulator)
import Foundation
import OpenBitFunMobileCore
import SwiftUI
import UIKit
import WebKit

/// Exercises the public iOS account factory and product page. Only its own
/// ephemeral simulator identity/Keychain service can reach the loopback fixture.
@MainActor
final class RemoteDesktopAccountProbe: ObservableObject {
    @Published private(set) var stage = "starting"
    @Published private(set) var selected = "none"
    @Published var desktopOpen = false
    @Published var desktop: RemoteDesktopModel?
    @Published var admission = "untested"
    @Published var keyboardCheck = "untested"
    @Published var queueStage = "untested"
    private var focusWindow: UIWindow?
    private let scope: any CoroutineScope = MainScope()
    private var account: AccountStore?
    private var observation: Task<Void, Never>?
    private var retired = false

    func open() {
        guard account == nil, !retired else { return }
        let env = ProcessInfo.processInfo.environment
        guard let text = env["OPENBITFUN_RD_PROBE_PORT"], let port = Int(text), (1024...65535).contains(port),
              let key = env["OPENBITFUN_RD_PROBE_KEY"], key.count == 64, key.allSatisfy({ $0.isHexDigit }) else {
            stage = "fixture_unavailable"; return
        }
        let id = UUID().uuidString
        let owner = AccountStore.companion.create(scope: scope, service: "com.openbitfun.mobile.rd-probe.\(id)",
            deviceId: id, deviceName: "Isolated iOS controller", log: CoreLogNone.shared)
        account = owner
        observation = Task { [weak self] in
            for await state in SkieSwiftStateFlow<AccountUiState>(owner.state) {
                guard !Task.isCancelled, let self, !self.retired else { return }
                if let ready = state as? AccountUiStateReady {
                    self.selected = ready.selectedDeviceId ?? "none"
                    if ready.selectedDeviceId != "chat-target" {
                        owner.dispatch(intent: AccountIntentSelectDevice(deviceId: "chat-target"))
                    } else { self.stage = "ready" }
                } else if let failed = state as? AccountUiStateFailed {
                    self.stage = "failed_\(failed.reason.name)_\(failed.stage.name)"
                } else if state is AccountUiStateSignedOut { self.stage = "signed_out" }
            }
        }
        owner.dispatch(intent: AccountIntentSelectRelay(relayUrl: "http://127.0.0.1:\(port)"))
        owner.dispatch(intent: AccountIntentLogin.shared)
    }
    func presentDesktop() {
        desktop = RemoteDesktopModel(factory: { [weak self] in self?.createDesktop() }); desktopOpen = true
    }
    func checkKeyboard() { Task { keyboardCheck = await RemoteDesktopKeyboardProbe.run() ? "passed" : "failed" } }
    func checkAdmission() { Task { admission = await RemoteDesktopControlBridgeProbe.run() ? "passed" : "failed" } }
    func burstTaps() {
        guard let desktop else { return }
        let state = desktop.controlSnapshot
        guard state.mode == .controlling, let binding = state.binding, let generation = state.generation else { return }
        let tap = RemoteDesktopControlIntentTap(binding: binding, intentEpoch: state.intentEpoch, generation: generation, x: 0.5, y: 0.5)
        desktop.controlIntent(tap); desktop.controlIntent(tap)
    }
    func queueTapAndStealFocus() {
        guard let desktop, let receiver = desktop.renderer, let scene = receiver.view.window?.windowScene,
              let binding = desktop.controlSnapshot.binding, let generation = desktop.controlSnapshot.generation else { return }
        let original = desktop.controlSnapshot
        // Stall the actual WK document BEFORE it can ask native admission.
        receiver.view.evaluateJavaScript("(()=>{const end=performance.now()+1200;while(performance.now()<end){}return true})()", completionHandler: nil)
        desktop.controlIntent(RemoteDesktopControlIntentTap(binding: binding, intentEpoch: original.intentEpoch,
            generation: generation, x: 0.5, y: 0.5))
        Task { [weak self, weak desktop, weak receiver] in
            try? await Task.sleep(nanoseconds: 100_000_000)
            guard let self, let desktop, let receiver else { return }
            guard receiver.pendingControlCount == 1, desktop.controlSnapshot.mode == .controlling else {
                self.queueStage = "not_queued"; return
            }
            self.queueStage = "queued_before_focus_loss"
            let window = UIWindow(windowScene: scene)
            window.windowLevel = .alert + 1
            window.rootViewController = UIHostingController(rootView: Button("Return to desktop") { [weak self] in
                self?.focusWindow?.isHidden = true; self?.focusWindow = nil
                receiver.view.window?.makeKey(); (receiver.view as? RemoteDesktopWebView)?.refreshFocus()
            }.accessibilityIdentifier("rd-account-return-focus"))
            self.focusWindow = window; window.makeKeyAndVisible()
        }
    }

    func createDesktop() -> RemoteDesktopSetupStore? {
        guard !retired else { return nil }
        return account?.createRemoteDesktopSetupStore(scope: scope, deviceId: "media-target")
    }
    func setForeground(_ active: Bool) { account?.setForeground(value: active) }
    func signOut() { account?.dispatch(intent: AccountIntentLogout.shared) }
    func close() {
        focusWindow?.isHidden = true; focusWindow = nil
        retired = true; observation?.cancel(); observation = nil
        account?.stop(); account = nil
    }
    deinit { observation?.cancel() }
}

struct RemoteDesktopAccountProbeView: View {
    @StateObject private var model = RemoteDesktopAccountProbe()
    @Environment(\.scenePhase) private var phase
    var body: some View {
        VStack(spacing: 24) {
            Text(model.stage).accessibilityIdentifier("rd-account-stage")
            Text(model.selected).accessibilityIdentifier("rd-account-chat-target")
            Button("Open desktop") { model.presentDesktop() }
                .disabled(model.stage != "ready").accessibilityIdentifier("rd-account-open")
            Text(model.admission).accessibilityIdentifier("rd-account-admission")
            Button("Check admission") { model.checkAdmission() }.accessibilityIdentifier("rd-account-check-admission")
            Text(model.keyboardCheck).accessibilityIdentifier("rd-account-keyboard-check")
            Button("Check keyboard") { model.checkKeyboard() }.accessibilityIdentifier("rd-account-check-keyboard")
            Button("Finish") { model.signOut() }.accessibilityIdentifier("rd-account-finish")
        }
        .onAppear { model.open() }
        .onDisappear { if !model.desktopOpen { model.close() } }
        .onChange(of: phase) { model.setForeground($0 == .active) }
        .fullScreenCover(isPresented: $model.desktopOpen) {
            if let desktop = model.desktop {
                RemoteDesktopView(target: MobileRemoteDesktopTarget(id: "media-target", name: "Fixture desktop"), model: desktop)
                    .overlay(alignment: .top) {
                        VStack {
                            Text(model.queueStage).accessibilityIdentifier("rd-account-queue-stage")
                            Button("Burst taps") { model.burstTaps() }.accessibilityIdentifier("rd-account-burst-taps")
                            Button("Queue tap and focus away") { model.queueTapAndStealFocus() }
                                .accessibilityIdentifier("rd-account-queue-focus")
                        }.offset(y: 70)
                    }
            }
        }
    }
}

#endif
