import OpenBitFunMobileCore
import SwiftUI
import WebKit

struct RemoteDesktopView: View {
    let target: MobileRemoteDesktopTarget
    @StateObject private var desktop: RemoteDesktopModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.scenePhase) private var phase
    init(target: MobileRemoteDesktopTarget, factory: @escaping () -> RemoteDesktopSetupStore?) {
        self.target = target; _desktop = StateObject(wrappedValue: RemoteDesktopModel(factory: factory))
    }
    #if DEBUG && targetEnvironment(simulator)
    init(target: MobileRemoteDesktopTarget, model: RemoteDesktopModel) {
        self.target = target; _desktop = StateObject(wrappedValue: model)
    }
    #endif
    var body: some View {
        RemoteDesktopPage(targetName: target.name, state: desktop.state, forceRelay: $desktop.forceRelay,
            dispatch: desktop.dispatch, close: { desktop.close(); dismiss() }, reconnect: desktop.reconnect, control: desktop.control, toggleControl: desktop.toggleControl,
            keyboardOpen: desktop.keyboard != nil, toggleKeyboard: desktop.toggleKeyboard, keyboardKey: desktop.keyboardKey) {
                if let id = desktop.mountID { RemoteDesktopMediaView(desktop: desktop, mount: id).id(id) }
            }
            .background(alignment: .bottomTrailing) {
                if let keyboard = desktop.keyboard {
                    RemoteDesktopKeyboardView(session: keyboard, host: desktop, closed: { desktop.closeKeyboard(keyboard.id) })
                        .frame(width: 1, height: 1).id(keyboard.id)
                }
            }
            .onAppear { desktop.open() }.onDisappear { desktop.close() }
            .onChange(of: phase) { value in if value != .active { desktop.close() } }
    }
}

/// Stateless native chrome; lifecycle and renderer ownership stay in the model/adapter.
struct RemoteDesktopPage<Media: View>: View {
    let targetName: String
    let state: RemoteDesktopSetupUiState
    @Binding var forceRelay: Bool
    let dispatch: (RemoteDesktopSetupIntent) -> Void
    let close: () -> Void
    let reconnect: () -> Void
    var control: RemoteDesktopControlUiState? = nil
    var toggleControl: () -> Void = {}
    var keyboardOpen = false
    var toggleKeyboard: () -> Void = {}
    var keyboardKey: (RemoteDesktopKeyboardKey) -> Void = { _ in }
    @ViewBuilder let media: () -> Media
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    private var compactKeyboard: Bool { keyboardOpen && verticalSizeClass == .compact }
    private var keys: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                key("Tab", .tab); key("Esc", .escape); key("←", .left); key("→", .right)
                key("⌫", .backspace); key("↵", .enter)
            }
        }.frame(height: 48)
    }
    private func copy(_ key: String) -> String { MobileLocalization.text("remoteDesktop.\(key)") }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                Button { close() } label: { Image(systemName: "xmark").frame(width: 48, height: 48).background(OpenBitFunTheme.mediaControlBackground, in: Circle()) }
                    .accessibilityLabel(copy("close")).accessibilityIdentifier("remote-desktop-close")
                Label(targetName, systemImage: "desktopcomputer").lineLimit(1).frame(maxWidth: .infinity)
                Menu {
                    if (state as? RemoteDesktopSetupUiStateViewing)?.sourceLifecycleSupported == true {
                        Button(copy("pause")) { dispatch(RemoteDesktopSetupIntentPause.shared) }.accessibilityIdentifier("remote-desktop-pause")
                    }
                    Button(copy("disconnect"), role: .destructive) { close() }
                } label: { Image(systemName: "ellipsis").frame(width: 48, height: 48).background(OpenBitFunTheme.mediaControlBackground, in: Circle()) }
                .accessibilityLabel(copy("more")).accessibilityIdentifier("remote-desktop-more")
            }
            .padding(.horizontal, 12).padding(.vertical, compactKeyboard ? 0 : 8)
            ZStack {
                media()
                status
            }.frame(maxWidth: .infinity, maxHeight: .infinity)
            if keyboardOpen && !compactKeyboard { keys.padding(.horizontal, 16) }
            HStack(spacing: 12) {
                if let control, control.supported {
                    Button(action: toggleControl) {
                        Text(copy(control.releasePending ? "releasing" : control.mode == .viewing ? "startControl" : "stopControl"))
                            .padding(.horizontal, 20).frame(minHeight: 48)
                            .background(OpenBitFunTheme.mediaControlBackground, in: Capsule())
                    }.disabled(control.releasePending || !(state is RemoteDesktopSetupUiStateViewing))
                        .accessibilityIdentifier("remote-desktop-control-toggle")
                    if let failure = control.failure {
                        Text(copy("controlFailure.\(failure.name)"))
                            .accessibilityIdentifier("remote-desktop-control-failure")
                    }
                } else { Text(copy("viewOnly")) }
                if compactKeyboard { keys } else { Spacer(minLength: 0) }
                Button(action: toggleKeyboard) {
                    Image(systemName: keyboardOpen ? "keyboard.chevron.compact.down" : "keyboard")
                        .frame(width: 48, height: 48).background(OpenBitFunTheme.mediaControlBackground, in: Circle())
                }.disabled(control?.mode != .controlling || control?.textSupported != true || control?.releasePending == true)
                    .accessibilityLabel(copy(keyboardOpen ? "hideKeyboard" : "showKeyboard"))
                    .accessibilityIdentifier("remote-desktop-keyboard-toggle")
            }.font(MobileDesignTypography.bodySmall.font)
                .padding(.horizontal, 16).padding(.vertical, compactKeyboard ? 0 : 10)
        }
        .foregroundStyle(OpenBitFunTheme.contentOnAction)
        .background(OpenBitFunTheme.mediaBackground.ignoresSafeArea())
        .buttonStyle(.plain)
        .interactiveDismissDisabled()
    }
    private func key(_ label: String, _ value: RemoteDesktopKeyboardKey) -> some View {
        Button { keyboardKey(value) } label: { Text(label).frame(minWidth: 48, minHeight: 44).contentShape(Rectangle()) }
            .accessibilityLabel(copy("key.\(value.name)"))
            .accessibilityIdentifier("remote-desktop-key-\(value.name)")
    }
    @ViewBuilder private var status: some View {
        switch state {
        case let choice as RemoteDesktopSetupUiStateChooseDisplay:
            choices(choice.displays, paused: false)
        case let choice as RemoteDesktopSetupUiStateChoosePausedDisplay:
            choices(choice.displays, paused: true)
        case is RemoteDesktopSetupUiStatePaused:
            VStack(spacing: 16) {
                Text(copy("paused"))
                action("resume") { dispatch(RemoteDesktopSetupIntentResume.shared) }
                action("changeDisplay") { dispatch(RemoteDesktopSetupIntentChangeDisplay.shared) }
            }
        case let failed as RemoteDesktopSetupUiStateFailed:
            VStack(spacing: 16) {
                Text(copy("failure.\(failed.reason.name)"))
                action("reconnect") { reconnect() }
            }.padding(24)
        case is RemoteDesktopSetupUiStateClosed:
            VStack(spacing: 16) { Text(copy("disconnected")); action("reconnect") { reconnect() } }
        case is RemoteDesktopSetupUiStateViewing: EmptyView()
        default: ProgressView().tint(OpenBitFunTheme.contentOnAction).accessibilityLabel(copy("connecting"))
        }
    }
    private func choices(_ displays: [RemoteDesktopDisplayUi], paused: Bool) -> some View {
        VStack(spacing: 16) {
            HStack {
                Text(copy("chooseDisplay")).font(MobileDesignTypography.titleSmall.font)
                if paused {
                    Spacer()
                    Button { dispatch(RemoteDesktopSetupIntentCancelDisplayChange.shared) } label: {
                        Text(copy("cancel")).frame(minWidth: 44, minHeight: 44).contentShape(Rectangle())
                    }.accessibilityIdentifier("remote-desktop-cancel")
                }
            }
            if !paused { Toggle(copy("forceRelay"), isOn: $forceRelay).accessibilityIdentifier("remote-desktop-force-relay") }
            ScrollView {
                VStack(spacing: 12) {
                    ForEach(Array(displays.enumerated()), id: \.element.id) { index, display in
                        Button {
                            if paused { dispatch(RemoteDesktopSetupIntentSelectPausedDisplay(displayId: display.id)) }
                            else { dispatch(RemoteDesktopSetupIntentSelectDisplay(displayId: display.id, forceRelay: forceRelay)) }
                        } label: {
                            HStack {
                                Text(MobileLocalization.format("remoteDesktop.displayNumber", language: MobileLocalization.restoredLanguage(), index + 1))
                                Spacer()
                                Text(MobileLocalization.format("remoteDesktop.dimensions", language: MobileLocalization.restoredLanguage(), display.width, display.height))
                                if (state as? RemoteDesktopSetupUiStateChoosePausedDisplay)?.display.id == display.id {
                                    Image(systemName: "checkmark").accessibilityLabel(copy("current"))
                                }
                            }.padding(16).background(OpenBitFunTheme.mediaControlBackground, in: RoundedRectangle(cornerRadius: 12))
                        }.accessibilityIdentifier("remote-desktop-display-\(index)")
                    }
                }
            }.frame(maxHeight: 320)
        }.frame(maxWidth: 480).padding(24)
    }
    private func action(_ key: String, perform: @escaping () -> Void) -> some View {
        Button(action: perform) {
            Text(copy(key)).padding(.horizontal, 20).frame(minHeight: 44)
                .background(OpenBitFunTheme.mediaControlBackground, in: Capsule())
        }
            .accessibilityIdentifier("remote-desktop-\(key)")
    }
}

private struct RemoteDesktopMediaView: UIViewRepresentable {
    @ObservedObject var desktop: RemoteDesktopModel
    let mount: UUID
    func makeCoordinator() -> RemoteDesktopReceiver {
        RemoteDesktopReceiver(prepared: { desktop.mediaEvent(RemoteDesktopMediaIntentPrepare.shared, mount: mount) },
            intent: { desktop.mediaEvent($0, mount: mount) }, controlHost: desktop)
    }
    func makeUIView(context: Context) -> WKWebView {
        desktop.renderer = context.coordinator
        context.coordinator.render(desktop.media)
        context.coordinator.syncControl(desktop.controlSnapshot)
        return context.coordinator.view
    }
    func updateUIView(_ view: WKWebView, context: Context) { context.coordinator.render(desktop.media); context.coordinator.syncControl(desktop.controlSnapshot); context.coordinator.prepareConnection() }
    static func dismantleUIView(_ view: WKWebView, coordinator: RemoteDesktopReceiver) { coordinator.close() }
}
