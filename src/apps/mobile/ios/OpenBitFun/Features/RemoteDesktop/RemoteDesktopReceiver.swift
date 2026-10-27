import Foundation
import OSLog
import SwiftUI
import OpenBitFunMobileCore
import WebKit

/// One bundled media document. Account IO never enters this adapter; the
/// optional native input bridge consumes only typed control snapshots/intents. A new PC mounts a new receiver; layout changes retain it.
@MainActor
final class RemoteDesktopReceiver: NSObject, WKScriptMessageHandler, WKScriptMessageHandlerWithReply, WKNavigationDelegate, WKUIDelegate {
    private(set) var view: WKWebView!
    private let intent: (RemoteDesktopMediaIntent) -> Void
    private let prepared: () -> Void
    private let page: URL?
    private var desired: RemoteDesktopMediaUiState?
    private var started: RemoteDesktopMediaUiState?
    private var sourceSent = false
    private var closed = false
    private var documentStarted = false
    private var bridgeReady = false
    private var apiReady = false
    private var ready = false
    private var timeout: DispatchWorkItem?
    private enum FailureStage: String { case bootstrap, configuration, evaluation, event, control, navigation, process }
    private let log = Logger(subsystem: "com.openbitfun.mobile.ios", category: "remote-desktop")
    private var input: RemoteDesktopControlBridge?
    #if DEBUG && targetEnvironment(simulator)
    var pendingControlCount: Int { input?.pendingCount ?? 0 }
    #endif
    private static let handler = "remoteDesktopMedia"

    init(prepared: @escaping () -> Void, intent: @escaping (RemoteDesktopMediaIntent) -> Void,
        controlHost: (any RemoteDesktopControlHost)? = nil) {
        self.prepared = prepared; self.intent = intent
        page = Bundle.main.url(forResource: "index", withExtension: "html", subdirectory: "RemoteDesktop")
        super.init()
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = false
        config.allowsPictureInPictureMediaPlayback = false
        let script = """
        (()=>{let tail=Promise.resolve(),poisoned=false;const host={postMessage:raw=>window.webkit.messageHandlers.remoteDesktopMedia.postMessage(raw),
        runControl:(id,count)=>{const next=tail.then(async()=>{if(poisoned)return false;for(let index=0;index<count;index++){
        const command=await window.webkit.messageHandlers.remoteDesktopControl.postMessage({id,index});if(!command)return false;
        await window.OpenBitFunDesktopReceiver.accept(command);}return true;});tail=next.catch(()=>{poisoned=true;});return next;}};
        Object.defineProperty(window,'OpenBitFunDesktopHost',{value:Object.freeze(host),writable:false,configurable:false});})();
        """
        config.userContentController.addUserScript(WKUserScript(source: script, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: Self.handler)
        if controlHost != nil { config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "remoteDesktopControl") }
        let native = RemoteDesktopWebView(frame: .zero, configuration: config)
        view = native
        view.accessibilityIdentifier = "remote-desktop-media"
        view.navigationDelegate = self; view.uiDelegate = self
        view.isOpaque = false; view.backgroundColor = UIColor(MobileDesignColors.transparent)
        view.scrollView.isScrollEnabled = false
        if let controlHost {
            let bridge = RemoteDesktopControlBridge(host: controlHost, execute: { [weak self] script, arguments, complete in
                guard let self, !self.closed else { complete(nil); return }
                self.view.callAsyncJavaScript(script, arguments: arguments, in: nil, in: .page) { result in
                    if case let .success(value) = result { complete(value as? Bool) } else { complete(nil) }
                }
            }, retired: { [weak self] id in
                // Cleanup for this document only; never restores or grants input.
                self?.send(["kind": "control", "renderer_id": id.rendererId, "attach_id": id.attachmentId,
                    "connection_id": id.connectionId, "body": ["kind": "release_control"]])
            }, ready: { intent(RemoteDesktopMediaIntentControlReady(binding: $0)) }, failed: { [weak self] in self?.fail(.control) })
            input = bridge
            let tap = UITapGestureRecognizer(target: bridge, action: #selector(RemoteDesktopControlBridge.tap(_:)))
            tap.delegate = bridge; tap.cancelsTouchesInView = true
            view.addGestureRecognizer(tap)
            native.focusChanged = { [weak bridge] in bridge?.focusChanged($0) }
            native.viewportChanged = { [weak bridge] in bridge?.viewportChanged($0) }
        }
        view.isUserInteractionEnabled = controlHost != nil
        let deadline = DispatchWorkItem { [weak self] in
            guard let self, !self.ready, !self.closed else { return }
            self.fail(.bootstrap)
        }
        timeout = deadline; DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: deadline)
        if let page { view.loadFileURL(page, allowingReadAccessTo: page.deletingLastPathComponent()) }
        else { DispatchQueue.main.async { [weak self] in self?.fail() } }
    }

    func render(_ value: RemoteDesktopMediaUiState?) {
        guard !closed else { return }
        desired = value
        input?.render(value)
        guard let value else {
            started = nil; sourceSent = false; view.isHidden = true
            if ready { evaluate("window.OpenBitFunDesktopReceiver.stop();void 0") }
            return
        }
        view.isHidden = false
        guard ready else { return }
        if let old = started {
            guard samePC(old, value), old.offerSdp == value.offerSdp, old.forceRelay == value.forceRelay,
                  old.iceServers == value.iceServers, old.controlSupported == value.controlSupported,
                  !sourceSent || value.sourceReady else { fail(.configuration); return }
        } else {
            started = value; sourceSent = false
            let servers = value.iceServers.map { ["urls": $0.urls, "username": $0.username, "credential": $0.credential] as [String: Any] }
            send(["kind": "start", "renderer_id": value.rendererId, "attach_id": value.attachmentId,
                  "connection_id": value.connectionId, "offer_sdp": value.offerSdp, "ice_servers": servers,
                  "force_relay": value.forceRelay, "control_supported": input?.sdkSupported == true && value.controlSupported,
                  "parent_focus": input?.sdkSupported == true && value.controlSupported,
                  "control_epoch": "0"])
        }
        if value.sourceReady && !sourceSent {
            sourceSent = true
            send(["kind": "source_ready", "renderer_id": value.rendererId, "connection_id": value.connectionId])
        }
    }

    func prepareConnection() { if ready && !closed { prepared() } }
    func syncControl(_ state: RemoteDesktopControlUiState) { if !closed { input?.sync(state) } }
    @discardableResult func control(_ command: RemoteDesktopControlRendererIntent) -> Bool {
        guard !closed, let input else { return false }
        input.command(command); return true
    }
    private func samePC(_ a: RemoteDesktopMediaUiState, _ b: RemoteDesktopMediaUiState) -> Bool {
        a.rendererId == b.rendererId && a.attachmentId == b.attachmentId && a.connectionId == b.connectionId
    }
    private func binding(_ value: RemoteDesktopMediaUiState) -> RemoteDesktopMediaBindingUi {
        RemoteDesktopMediaBindingUi(rendererId: value.rendererId, attachmentId: value.attachmentId, connectionId: value.connectionId)
    }
    private func becameReady() {
        guard !closed, !ready, bridgeReady, apiReady else { return }
        ready = true; timeout?.cancel(); timeout = nil
        prepared(); render(desired)
    }
    private func send(_ object: [String: Any], delivered: @escaping () -> Void = {}) {
        guard let data = try? JSONSerialization.data(withJSONObject: object), let json = String(data: data, encoding: .utf8) else { fail(); return }
        evaluate("window.OpenBitFunDesktopReceiver.accept(\(json));void 0", delivered: delivered)
    }
    private func evaluate(_ script: String, delivered: @escaping () -> Void = {}) {
        guard !closed else { return }
        view.evaluateJavaScript(script) { [weak self] _, error in
            guard let self, !self.closed else { return }
            if error != nil { self.fail(.evaluation) } else { delivered() }
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard !closed, message.name == Self.handler, message.frameInfo.isMainFrame,
              message.frameInfo.request.url == page, let text = message.body as? String,
              let data = text.data(using: .utf8), data.count <= 96 * 1024,
              let event = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], let kind = event["kind"] as? String else { return }
        if kind == "bridge_ready" {
            bridgeReady = true
            input?.sdkSupported = (event["capabilities"] as? [String])?.contains("control_epoch_v1") == true
            becameReady(); return
        }
        guard let current = started, event["renderer_id"] as? String == current.rendererId,
              event["attach_id"] as? String == current.attachmentId, event["connection_id"] as? String == current.connectionId else { return }
        let id = binding(current)
        switch kind {
        case "answer":
            guard let sdp = event["answer_sdp"] as? String else { fail(); return }
            intent(RemoteDesktopMediaIntentAnswer(binding: id, sdp: sdp))
        case "first_frame_presented", "frame_resized":
            func dimension(_ name: String) -> Int32? {
                guard let n = event[name] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
                      n.doubleValue.isFinite, n.doubleValue.rounded() == n.doubleValue, (1...32768).contains(n.intValue) else { return nil }
                return n.int32Value
            }
            guard let width = dimension("width"), let height = dimension("height") else { fail(); return }
            (view as? RemoteDesktopWebView)?.refreshFocus()
            input?.geometry(width, height)
            intent(RemoteDesktopMediaIntentFramePresented(binding: id, width: width, height: height))
            input?.reconcileReady()
        case "health":
            intent(RemoteDesktopMediaIntentHealth(binding: id, localCandidate: event["candidate_type"] as? String ?? "",
                remoteCandidate: event["remote_candidate_type"] as? String ?? ""))
            input?.reconcileReady()
        case "focus_probe":
            guard let echo = event["echo"] as? String, (1...20).contains(echo.count), echo.allSatisfy({ $0.isNumber && $0.isASCII }) else { fail(); return }
            (view as? RemoteDesktopWebView)?.refreshFocus()
            send(["kind": "focus_reply", "renderer_id": id.rendererId, "attach_id": id.attachmentId,
                "connection_id": id.connectionId, "echo": echo, "focused": input?.focused == true]) { [weak self] in self?.input?.focusDelivered(id) }
        case "control_state": input?.report(event, binding: id)
        case "failed", "bridge_failed":
            // Closed diagnostic vocabulary only; never log event bodies or SDP.
            let stage = event["stage"] as? String ?? ""
            let allowed = ["peer", "channel", "track", "playback", "ice_no_candidates", "ice_486", "stats", "setup"]
            let diagnostic = allowed.contains(stage) ? stage : "receiver"
            log.error("Remote desktop receiver event failed stage=\(diagnostic, privacy: .public)")
            fail()
        default: break
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
        replyHandler: @escaping (Any?, String?) -> Void) {
        guard !closed, message.name == "remoteDesktopControl", message.frameInfo.isMainFrame,
              message.frameInfo.request.url == page, let input else { replyHandler(false, nil); return }
        replyHandler(input.consume(message.body), nil)
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard !closed, !documentStarted, action.targetFrame?.isMainFrame == true, action.request.url == page else {
            decisionHandler(.cancel); fail(.navigation); return
        }
        documentStarted = true; decisionHandler(.allow)
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard !closed, webView.url == page else { fail(); return }
        webView.evaluateJavaScript("({secure:window.isSecureContext===true,rtc:typeof RTCPeerConnection==='function',receiver:!!window.OpenBitFunDesktopReceiver})") { [weak self] result, error in
            guard let self, !self.closed else { return }
            guard error == nil, let result = result as? [String: Any], result["secure"] as? Bool == true,
                  result["rtc"] as? Bool == true, result["receiver"] as? Bool == true else { self.fail(); return }
            self.apiReady = true; self.becameReady()
        }
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { fail() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { fail() }
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { fail(.process) }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { fail(); return nil }
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) { decisionHandler(.deny) }

    private func fail(_ stage: FailureStage = .event) {
        guard !closed else { return }
        log.error("Remote desktop receiver failed stage=\(stage.rawValue, privacy: .public)")
        let previous = started
        close()
        if let previous { intent(RemoteDesktopMediaIntentFailed(binding: binding(previous))) }
        else { intent(RemoteDesktopMediaIntentUnavailable.shared) }
    }
    func close() {
        guard !closed else { return }
        log.info("Remote desktop receiver closed had_media=\(self.started != nil)")
        closed = true; input?.close(); desired = nil; started = nil
        timeout?.cancel(); timeout = nil
        let old = view!
        old.isHidden = true; old.navigationDelegate = nil; old.uiDelegate = nil
        old.configuration.userContentController.removeScriptMessageHandler(forName: Self.handler)
        old.configuration.userContentController.removeScriptMessageHandler(forName: "remoteDesktopControl", contentWorld: .page)
        old.configuration.userContentController.removeAllUserScripts()
        old.stopLoading()
        if ready { old.evaluateJavaScript("window.OpenBitFunDesktopReceiver?.stop();void 0", completionHandler: nil) }
        // WKWebView releases its native page with its mounted view. Do not wait
        // for a remote ACK or keep account owners alive during that teardown.
        // SwiftUI owns removal of its mounted UIView. Hide and retire this
        // document immediately; do not mutate the hosting view hierarchy here.
    }
}
