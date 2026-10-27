import UIKit
import WebKit

/// UIKit window facts only; no lease or account policy. A native modal/window
/// can retire input without relying on the web document's cached focus value.
@MainActor
final class RemoteDesktopWebView: WKWebView {
    var focusChanged: ((Bool) -> Void)?
    var viewportChanged: ((CGSize) -> Void)?
    private var size = CGSize.zero
    private var observers: [NSObjectProtocol] = []
    override init(frame: CGRect, configuration: WKWebViewConfiguration) {
        super.init(frame: frame, configuration: configuration)
        let center = NotificationCenter.default
        for name in [UIWindow.didBecomeKeyNotification, UIApplication.didBecomeActiveNotification] {
            observers.append(center.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in self?.refreshFocus() })
        }
        observers.append(center.addObserver(forName: UIWindow.didResignKeyNotification, object: nil, queue: .main) { [weak self] note in
            guard let self, let changed = note.object as? UIWindow, changed === self.window else { return }
            self.focusChanged?(false)
        })
        observers.append(center.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { [weak self] _ in self?.focusChanged?(false) })
    }
    required init?(coder: NSCoder) { fatalError("Programmatic media view required") }
    override func didMoveToWindow() { super.didMoveToWindow(); refreshFocus() }
    override func layoutSubviews() {
        super.layoutSubviews()
        if size != bounds.size { size = bounds.size; viewportChanged?(size) }
    }
    func refreshFocus() {
        focusChanged?(window?.isKeyWindow == true && UIApplication.shared.applicationState == .active
            && window?.windowScene?.activationState == .foregroundActive && !isHidden)
    }
    deinit { observers.forEach(NotificationCenter.default.removeObserver) }
}
