"""Native GTK 3 / WebKit2 4.1 API probe; never captures or injects input."""
import argparse
import json
from pathlib import Path
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--html', required=True, type=Path)
    parser.add_argument('--enable-webrtc', action='store_true')
    parser.add_argument('--https-origin-control', action='store_true')
    args = parser.parse_args()
    if not sys.platform.startswith('linux'):
        parser.error('Run the native probe on Linux with GTK/WebKitGTK and a display')
    page = args.html.read_bytes()
    if not 0 < len(page) <= 2 * 1024 * 1024:
        parser.error('Invalid local fixture size')

    import gi
    gi.require_version('Gtk', '3.0')
    gi.require_version('WebKit2', '4.1')
    from gi.repository import Gio, GLib, Gtk, WebKit2

    Gtk.init([])
    settings = WebKit2.Settings()
    result = {
        'scope': 'native WebKitGTK API and production opaque receiver startup',
        'media_verified': False,
        'actual_tauri_process_verified': False,
        'explicit_enable_webrtc': args.enable_webrtc,
        'webkit_version': [WebKit2.get_major_version(), WebKit2.get_minor_version(), WebKit2.get_micro_version()],
        'events': [], 'permission_requests': 0,
    }
    for name in ['enable-webrtc', 'enable-media-stream', 'media-playback-requires-user-gesture']:
        if settings.find_property(name):
            result['default_' + name] = settings.get_property(name)
    if args.enable_webrtc and settings.find_property('enable-webrtc'):
        settings.set_property('enable-webrtc', True)
    result['effective_enable_webrtc'] = settings.get_property('enable-webrtc') if settings.find_property('enable-webrtc') else None
    context = WebKit2.WebContext.get_default()
    # Observation only. Do not change the engine's sandbox or permission policy.
    result['webkit_sandbox_enabled'] = context.get_sandbox_enabled() if hasattr(context, 'get_sandbox_enabled') else None
    manager = WebKit2.UserContentManager()
    manager.register_script_message_handler('probe')
    view = WebKit2.WebView(user_content_manager=manager, settings=settings, web_context=context)
    window = Gtk.Window()
    window.set_default_size(840, 520)
    window.add(view)
    finished = False
    ready = False
    started = False

    def finish():
        nonlocal finished
        if finished:
            return False
        finished = True
        print(json.dumps(result), flush=True)
        window.destroy()
        Gtk.main_quit()
        return False

    def evaluate(script):
        view.evaluate_javascript(script, -1, None, None, None, None, None)

    def permission(_view, request):
        result['permission_requests'] += 1
        request.deny()
        return True

    def start_when_ready():
        nonlocal started
        if started or not ready or 'opaque_api' not in result:
            return
        started = True
        api = result['opaque_api']
        result['api_available'] = api.get('secure_context') is True and api.get('peer_api') == 'function' and api.get('frame_callback') == 'function'
        if result['api_available']:
            # API presence alone proves no codec, transport or frame delivery.
            evaluate('window.probeStop()')
        else:
            # The receiver must fail before parsing SDP or allocating a PC.
            command = {'kind': 'start', 'renderer_id': 'linux-api-probe',
                       'attach_id': 'generated-only', 'connection_id': 'api-only',
                       'offer_sdp': 'deliberately-invalid-api-probe',
                       'ice_servers': [], 'force_relay': False, 'control_supported': False}
            evaluate('window.probeCommand(' + json.dumps(command) + ')')

    def event(_manager, message):
        nonlocal ready
        try:
            value = json.loads(message.get_js_value().to_string())
        except Exception:
            result['invalid_bridge_message'] = True
            GLib.idle_add(finish)
            return
        kind = value.get('kind')
        if kind in ['environment', 'opaque_api']:
            result[kind] = value
        elif kind == 'controller_preflight':
            result[kind] = value
            result['controller_preflight_verified'] = (value.get('request_count') == 0
                and value.get('turn_count') == 0 and value.get('stage') == 'failed'
                and value.get('error') == 'media_backend_unavailable')
            result['controller_startup_race_verified'] = (result['controller_preflight_verified']
                and value.get('opened_before_ready') is True)
        elif kind == 'bridge_ready':
            ready = True
            result['bridge_ready'] = True
        elif kind in ['failed', 'fixture_failed']:
            # Only finite diagnostic codes, never arbitrary exception/SDP text.
            code = value.get('code')
            result['events'].append({'kind': kind, 'code': code if code == 'media_backend_unavailable' else 'unexpected_failure'})
            result['unavailable_refused'] = code == 'media_backend_unavailable'
            evaluate('window.probeStop()')
        elif kind == 'fixture_stopped':
            result['receiver_stopped'] = True
            GLib.timeout_add(200, finish)
        else:
            result['events'].append({'kind': kind})
        start_when_ready()

    manager.connect('script-message-received::probe', event)
    view.connect('permission-request', permission)

    def uri_request(request, *_unused):
        request.finish(Gio.MemoryInputStream.new_from_bytes(GLib.Bytes.new(page)), len(page), 'text/html')

    # Wry 0.56 registers app protocols as secure on GTK; preserve that boundary.
    context.get_security_manager().register_uri_scheme_as_secure('tauri')
    context.register_uri_scheme('tauri', uri_request)
    if args.https_origin_control:
        result['page_uri'] = 'https://localhost/ (load_html base URI control)'
        view.load_html(page.decode(), 'https://localhost/')
    else:
        result['page_uri'] = 'tauri://localhost/'
        view.load_uri('tauri://localhost/')
    window.show_all()
    view.grab_focus()

    def timeout():
        result['timeout'] = True
        return finish()

    GLib.timeout_add_seconds(25, timeout)
    Gtk.main()
    if (result.get('timeout') or not result.get('receiver_stopped') or result['permission_requests']
            or not result.get('api_available') and not result.get('unavailable_refused')
            or 'controller_preflight' in result and not result.get('controller_preflight_verified')
            or result.get('controller_preflight', {}).get('opened_before_ready') is not None
                and not result.get('controller_startup_race_verified')):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
