import Foundation
import OpenBitFunMobileCore

struct MobileRemoteDesktopTarget: Identifiable {
    let id: String
    let name: String
}

/// Presentation/lifecycle only. Account membership, signaling, CAS, budgets and
/// cleanup remain in the existing KMP store. No Agent target selection.
@MainActor
final class RemoteDesktopModel: ObservableObject, RemoteDesktopControlHost {
    private static var inactiveControl: RemoteDesktopControlUiState {
        RemoteDesktopControlUiState(binding: nil, supported: false, mode: .viewing, generation: nil, intentEpoch: 0, releasePending: false, failure: nil, textSupported: false)
    }
    @Published private(set) var control = inactiveControl
    @Published private(set) var keyboard: RemoteDesktopKeyboardSession?
    var controlSnapshot: RemoteDesktopControlUiState {
        guard let store else { return Self.inactiveControl }
        return SkieSwiftStateFlow<RemoteDesktopControlUiState>(store.control).value
    }
    @Published private(set) var state: RemoteDesktopSetupUiState = RemoteDesktopSetupUiStateIdle.shared
    @Published private(set) var media: RemoteDesktopMediaUiState?
    @Published private(set) var mountID: UUID?
    @Published var forceRelay = false
    weak var renderer: RemoteDesktopReceiver?
    private let factory: () -> RemoteDesktopSetupStore?
    private var store: RemoteDesktopSetupStore?
    private var tasks: [Task<Void, Never>] = []
    private var generation = UUID()
    private var connection: String?

    init(factory: @escaping () -> RemoteDesktopSetupStore?) { self.factory = factory }
    func open() {
        guard store == nil else { return }
        let token = UUID(); generation = token
        guard let owner = factory() else {
            state = RemoteDesktopSetupUiStateFailed(reason: .accountChanged); return
        }
        store = owner
        tasks = [Task { [weak self] in
            for await value in SkieSwiftStateFlow<RemoteDesktopSetupUiState>(owner.state) {
                guard !Task.isCancelled, let self, self.generation == token else { return }
                if let attached = value as? RemoteDesktopSetupUiStateAttached, self.connection != attached.connectionId {
                    self.renderer?.close(); self.renderer = nil
                    self.connection = attached.connectionId; self.mountID = UUID()
                }
                if !(value is RemoteDesktopSetupUiStateAttached || value is RemoteDesktopSetupUiStateAwaitingFrame
                    || value is RemoteDesktopSetupUiStateViewing || value is RemoteDesktopSetupUiStateSuspending) {
                    self.renderer?.close(); self.renderer = nil
                    self.mountID = nil; self.connection = nil; self.media = nil
                }
                self.state = value
            }
        }, Task { [weak self] in
            for await value in SkieSwiftOptionalStateFlow<RemoteDesktopMediaUiState>(owner.media) {
                guard !Task.isCancelled, let self, self.generation == token else { return }
                // Initial null is the not-yet-prepared state, not retirement.
                // A real media-to-null transition must still stop immediately.
                if value == nil && self.media != nil { self.renderer?.close() }
                self.media = value
            }
        }, Task { [weak self] in
            for await value in SkieSwiftStateFlow<RemoteDesktopControlUiState>(owner.control) {
                guard !Task.isCancelled, let self, self.generation == token else { return }
                if self.keyboard?.matches(value) == false { self.retireKeyboard() }
                self.control = value; self.renderer?.syncControl(value)
            }
        }, Task { [weak self] in
            for await value in SkieSwiftFlow<RemoteDesktopControlRendererIntent>(owner.rendererControlIntents) {
                guard !Task.isCancelled, let self, self.generation == token else { return }
                if self.renderer?.control(value) != true {
                    owner.dispatchMedia(intent: RemoteDesktopMediaIntentFailed(binding: value.binding))
                }
            }
        }]
        owner.dispatch(intent: RemoteDesktopSetupIntentLoad.shared)
    }
    func controlIntent(_ value: RemoteDesktopControlIntent) { store?.dispatchControl(intent: value) }
    func controlReport(_ value: RemoteDesktopControlReportIntent) { store?.reportControl(intent: value) }
    func toggleKeyboard() {
        if keyboard != nil { retireKeyboard(); return }
        let state = controlSnapshot
        guard state.supported, state.textSupported, state.mode == .controlling, !state.releasePending else { return }
        keyboard = RemoteDesktopKeyboardSession(authority: state)
    }
    private func retireKeyboard() { keyboard?.retire(); keyboard = nil }
    func closeKeyboard(_ id: UUID) { if keyboard?.id == id { retireKeyboard() } }
    func keyboardKey(_ key: RemoteDesktopKeyboardKey) {
        guard let session = keyboard, session.matches(controlSnapshot), let binding = session.authority.binding,
              let generation = session.authority.generation else { return }
        controlIntent(RemoteDesktopControlIntentKeyTap(binding: binding, intentEpoch: session.authority.intentEpoch, generation: generation, key: key))
    }
    func toggleControl() {
        let current = controlSnapshot
        guard let binding = current.binding else { return }
        if current.mode == .viewing && !current.releasePending {
            controlIntent(RemoteDesktopControlIntentAcquire(binding: binding, intentEpoch: current.intentEpoch))
        } else if current.mode != .viewing {
            controlIntent(RemoteDesktopControlIntentRelease(binding: binding, intentEpoch: current.intentEpoch))
        }
    }
    func dispatch(_ intent: RemoteDesktopSetupIntent) { store?.dispatch(intent: intent) }
    func mediaEvent(_ intent: RemoteDesktopMediaIntent, mount: UUID) {
        guard mountID == mount else { return }
        store?.dispatchMedia(intent: intent)
    }
    func reconnect() { close(); open() }
    func close() {
        retireKeyboard()
        renderer?.close(); renderer = nil
        generation = UUID(); media = nil; mountID = nil; connection = nil
        tasks.forEach { $0.cancel() }; tasks = []
        store?.close(); store = nil
        control = Self.inactiveControl
        state = RemoteDesktopSetupUiStateClosed.shared
    }
    deinit { tasks.forEach { $0.cancel() } }
}
