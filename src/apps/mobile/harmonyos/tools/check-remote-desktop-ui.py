#!/usr/bin/env python3
"""Check the production read-only panel and bundled bridge without account/media IO.

Uses debug-only remote-desktop preview. Checks actual ArkWeb resource load,
compact/wide layout, live resize retaining the bridge, trust copy and exit.
This fixture is not evidence of native capture, TURN or account authorization.
"""
import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--hdc', default=os.environ.get('HDC', 'hdc'))
    parser.add_argument('--device')
    parser.add_argument('--keyboard-only', action='store_true', help='Check direct virtual keyboard callbacks in compact/wide, themes and portrait')
    parser.add_argument('--gesture-only', action='store_true', help='Check real native double-tap drag intents without account or OS injection')
    parser.add_argument('--source-only', action='store_true', help='Check native display selection, cancel and view-only resume in compact/wide and both themes; no account or OS input')
    parser.add_argument('--quality-only', action='store_true', help='Check all quality choices while paused, explicit resume and live resize in compact/wide and both themes; no account, pixels or OS input')
    parser.add_argument('--layout-only', action='store_true', help='Check connection/control layout transitions without repeating the IME matrix')
    parser.add_argument('--rotation-only', action='store_true', help='Rotate the same native page with the IME open; check release, bridge retention and new click coordinates')
    args = parser.parse_args()
    command = [args.hdc] + (['-t', args.device] if args.device else [])
    output = Path(tempfile.mkdtemp(prefix='openbitfun-rd-ui-'))
    print(f'Evidence: {output}', flush=True)
    contract = Path(__file__).resolve().parent.parent / 'entry/src/main/ets/services/HarmonyUpgradeIdentityContract.ets'
    bundle = re.search(r"APP_BUNDLE:\s*string\s*=\s*'([^']+)'", contract.read_text()).group(1)

    def run(*parts):
        result = subprocess.check_output(command + list(parts), text=True, timeout=30)
        if any(line.startswith('[Fail]') for line in result.splitlines()):
            raise RuntimeError('HDC did not confirm the device operation')
        return result

    def start(scenario=None, landscape=False):
        run('shell', 'aa', 'force-stop', bundle)
        parts = ['shell', 'aa', 'start', '-a', 'EntryAbility', '-b', bundle]
        if scenario:
            parts += ['--ps', 'openbitfunDesignPreview', scenario]
        if scenario:
            parts += ['--ps', 'remoteDesktopPreviewLandscape', 'true' if landscape else 'false']
        run(*parts)
        time.sleep(1)

    def layout(label):
        remote = '/data/local/tmp/openbitfun-rd-ui.json'
        run('shell', 'uitest', 'dumpLayout', '-p', remote)
        local = output / f'{label}.json'
        run('file', 'recv', remote, str(local))
        nodes = []
        def walk(node):
            nodes.append(node.get('attributes', {}))
            for child in node.get('children', []):
                walk(child)
        walk(json.loads(local.read_text()))
        return nodes

    def click(nodes, field, value, in_toolbar=False, activate=True):
        for attempt in range(8):
            node = next((item for item in nodes if item.get(field) == value), None)
            menu = next((item for item in nodes if item.get('id') == 'rd-more-scroll'), None)
            toolbar = menu or next((item for item in nodes if item.get('id') == 'rd-toolbar'), None)
            if node:
                left, top, right, bottom = map(int, re.findall(r'-?\d+', node['bounds']))
                if (field != 'text' and not in_toolbar and menu is None) or toolbar is None:
                    break
                tl, tt, tr, tb = map(int, re.findall(r'-?\d+', toolbar['bounds']))
                if tt <= top and bottom <= tb:
                    break
            assert toolbar is not None, f'No control or scroll region: {value}'
            tl, tt, tr, tb = map(int, re.findall(r'-?\d+', toolbar['bounds']))
            reverse = node is not None and top < tt
            run('shell', 'uitest', 'uiInput', 'swipe', str((tl + tr) // 2), str(tt + 12 if reverse else tb - 12),
                str((tl + tr) // 2), str(tb - 12 if reverse else tt + 12))
            time.sleep(.2)
            nodes = layout(f'scroll-{value}-{attempt}')
        else:
            raise AssertionError(f'Control not fully reachable: {value}')
        if activate:
            run('shell', 'uitest', 'uiInput', 'click', str((left + right) // 2), str((top + bottom) // 2))
            time.sleep(.3)

    def diagnostic(nodes):
        return next(node['text'] for node in nodes if node.get('id') == 'rd-preview-diagnostics')

    def screenshot(label):
        remote = '/data/local/tmp/openbitfun-rd-ui.jpeg'
        run('shell', 'snapshot_display', '-f', remote)
        run('file', 'recv', remote, str(output / f'{label}.jpeg'))

    original_landscape = None
    try:
        initial = layout('initial-orientation')
        root = next(n for n in initial if n.get('type') == 'root')
        left, top, right, bottom = map(int, re.findall(r'-?\d+', root['bounds']))
        original_landscape = right-left > bottom-top
        # Keep only orientation, not the ordinary App's initial content.
        (output / 'initial-orientation.json').unlink()
        if args.quality_only:
            for compact, dark in [(False, False), (True, False), (False, True), (True, True)]:
                label = ('quality-compact' if compact else 'quality-wide') + ('-dark' if dark else '-light')
                start('remote-desktop-dark' if dark else 'remote-desktop', landscape=True)
                nodes = layout(label + '-ready')
                if compact:
                    click(nodes, 'id', 'rd-preview-resize')
                    nodes = layout(label + '-compact')
                click(nodes, 'id', 'rd-preview-control')
                nodes = layout(label + '-viewing')
                assert not any(n.get('id') == 'rd-quality-options' for n in nodes)
                click(nodes, 'id', 'rd-more-options')
                click(layout(label + '-menu'), 'id', 'rd-pause-source')
                paused = layout(label + '-paused')
                for quality in ['balanced', 'clear', 'data_saver']:
                    click(paused, 'id', 'rd-quality-' + quality, in_toolbar=True, activate=False)
                    nodes = layout(label + '-' + quality + '-before')
                    choice = next(n for n in nodes if n.get('id') == 'rd-quality-' + quality)
                    name = choice['text']
                    assert name and 'remoteDesktop.' not in name
                    click(nodes, 'id', 'rd-quality-' + quality, in_toolbar=True)
                    paused = layout(label + '-' + quality + '-selected')
                    selected = next(n for n in paused if n.get('id') == 'rd-quality-' + quality)
                    assert selected.get('enabled') == 'false', 'Current preset did not become selected'
                    assert 'control=viewing' in diagnostic(paused) and 'inputs=0' in diagnostic(paused)
                    assert 'bridge=1 closed=0' in diagnostic(paused), 'Quality choice replaced the native bridge'
                    click(paused, 'id', 'rd-quality-current', in_toolbar=True, activate=False)
                    paused = layout(label + '-' + quality + '-current')
                    current = next(n for n in paused if n.get('id') == 'rd-quality-current')
                    assert name in current['text'], 'Current quality label was not updated'
                screenshot(label + '-selected')
                click(paused, 'id', 'rd-preview-resize')
                resized = layout(label + '-resized')
                assert 'bridge=1 closed=0' in diagnostic(resized) and 'inputs=0' in diagnostic(resized)
                click(resized, 'id', 'rd-resume-source', in_toolbar=True)
                resumed = layout(label + '-resumed')
                assert 'control=viewing' in diagnostic(resumed) and 'inputs=0' in diagnostic(resumed)
                assert not any(n.get('id') == 'rd-quality-options' for n in resumed)
                print(f'PASS {label}: all presets stay paused, translated current label, one bridge, explicit view-only resume and live resize; no account or OS input', flush=True)
            return
        if args.source_only:
            for compact, dark in [(False, False), (True, False), (False, True), (True, True)]:
                label = ('source-compact' if compact else 'source-wide') + ('-dark' if dark else '-light')
                start('remote-desktop-dark' if dark else 'remote-desktop', landscape=True)
                nodes = layout(label + '-ready')
                if compact:
                    click(nodes, 'id', 'rd-preview-resize')
                    nodes = layout(label + '-compact')
                click(nodes, 'id', 'rd-preview-control')
                nodes = layout(label + '-viewing')
                start_control = next(n['text'] for n in nodes if n.get('text') in ['开启操作', 'Start control'])
                click(nodes, 'text', start_control)
                nodes = layout(label + '-controlling')
                click(nodes, 'id', 'rd-more-options')
                menu = layout(label + '-menu')
                click(menu, 'id', 'rd-pause-source')
                paused = layout(label + '-paused')
                assert 'control=viewing' in diagnostic(paused) and 'bridge=1 closed=0' in diagnostic(paused)
                click(paused, 'id', 'rd-choose-source', in_toolbar=True)
                choosing = layout(label + '-choosing')
                assert any(n.get('id') == 'rd-source-display-1' for n in choosing), 'Second authorized display missing'
                screenshot(label + '-choosing')
                click(choosing, 'id', 'rd-source-display-1', in_toolbar=True)
                selected = layout(label + '-selected')
                assert 'selected=display-b:false' in diagnostic(selected), 'Selected display identity was lost'
                assert 'control=viewing' in diagnostic(selected) and 'inputs=0' in diagnostic(selected)
                assert 'bridge=1 closed=0' in diagnostic(selected), 'Display selection replaced the native bridge'
                click(selected, 'id', 'rd-more-options')
                click(layout(label + '-second-menu'), 'id', 'rd-pause-source')
                paused = layout(label + '-second-paused')
                current = next(n for n in paused if n.get('id') == 'rd-current-source')
                assert '2' in current.get('text', ''), 'Paused page names the wrong selected display'
                click(paused, 'id', 'rd-choose-source', in_toolbar=True)
                choosing = layout(label + '-cancel-picker')
                click(choosing, 'id', 'rd-cancel-source', in_toolbar=True)
                paused = layout(label + '-cancelled')
                assert any(n.get('id') == 'rd-resume-source' for n in paused)
                assert 'selected=display-b:false' in diagnostic(paused) and 'control=viewing' in diagnostic(paused)
                screenshot(label + '-cancelled')
                click(paused, 'id', 'rd-resume-source', in_toolbar=True)
                resumed = layout(label + '-resumed')
                assert 'control=viewing' in diagnostic(resumed) and 'bridge=1 closed=0' in diagnostic(resumed)
                assert 'inputs=0' in diagnostic(resumed), 'Selection/cancel replayed input'
                click(resumed, 'id', 'rd-preview-resize')
                resized = layout(label + '-resized')
                assert 'selected=display-b:false' in diagnostic(resized) and 'bridge=1 closed=0' in diagnostic(resized)
                screenshot(label + '-resized')
                print(f'PASS {label}: display B selection, current label, cancel, view-only resume and live resize; no account or native host', flush=True)
            return
        if args.rotation_only:
            for dark in [False, True]:
                label = 'rotation-dark' if dark else 'rotation-light'
                start('remote-desktop-dark' if dark else 'remote-desktop', landscape=False)
                nodes = layout(label + '-portrait')
                pid = run('shell', 'pidof', bundle).strip()
                click(nodes, 'text', '1280 × 830')
                click(layout(label + '-selected'), 'id', 'rd-preview-control')
                for landscape in [True, False]:
                    prefix = label + ('-to-landscape' if landscape else '-to-portrait')
                    nodes = layout(prefix + '-before')
                    start_control = next(n['text'] for n in nodes if n.get('text') in ['开启操作', 'Start control'])
                    before_inputs = int(re.search(r'inputs=(\d+)', diagnostic(nodes))[1])
                    click(nodes, 'text', start_control)
                    click(layout(prefix + '-control'), 'id', 'rd-keyboard-toggle')
                    for _ in range(12):
                        nodes = layout(prefix + '-ime')
                        if any(n.get('id') == 'KeyboardCanvas' for n in nodes):
                            break
                        time.sleep(.2)
                    assert any(n.get('id') == 'KeyboardCanvas' for n in nodes), 'IME did not open before rotation'
                    assert any(n.get('text') in ['停止操作', 'Stop control'] for n in nodes), 'IME opening lost control before rotation'
                    click(nodes, 'id', 'rd-more-options')
                    click(layout(prefix + '-options'), 'id', 'rd-rotate-screen')
                    for _ in range(16):
                        nodes = layout(prefix + '-rotated')
                        pane = next(n for n in nodes if n.get('id') == 'rd-preview-pane')
                        left, top, right, bottom = map(int, re.findall(r'-?\d+', pane['bounds']))
                        matches = (right-left > bottom-top) if landscape else (bottom-top > right-left)
                        if matches and 'control=viewing' in diagnostic(nodes) and not any(n.get('id') == 'rd-virtual-keyboard' for n in nodes):
                            break
                        time.sleep(.2)
                    else:
                        raise AssertionError('Live rotation did not release control and close the keyboard')
                    receipt = diagnostic(nodes)
                    assert 'bridge=1 closed=0 selected=display-a:false' in receipt, 'Rotation replaced the receiver or selected target: ' + receipt
                    assert int(re.search(r'inputs=(\d+)', receipt)[1]) == before_inputs, 'Rotation generated input'
                    assert run('shell', 'pidof', bundle).strip() == pid, 'Rotation restarted the App'
                    click(nodes, 'text', start_control)
                    nodes = layout(prefix + '-reacquired')
                    surface = next(n for n in nodes if n.get('id') == 'rd-input-surface')
                    sl, st, sr, sb = map(int, re.findall(r'-?\d+', surface['bounds']))
                    fit = min((sr-sl)/1280, (sb-st)/830)
                    x = sl + (sr-sl-1280*fit)/2 + 1280*fit*.25
                    y = st + (sb-st-830*fit)/2 + 830*fit*.75
                    run('shell', 'uitest', 'uiInput', 'click', str(round(x)), str(round(y)))
                    nodes = layout(prefix + '-clicked')
                    receipt = diagnostic(nodes)
                    point = re.search(r'point=(\d+):(\d+)', receipt)
                    assert point and abs(int(point[1])-250) <= 3 and abs(int(point[2])-750) <= 3, 'Rotated click used stale geometry: ' + receipt
                    assert int(re.search(r'inputs=(\d+)', receipt)[1]) == before_inputs + 2, 'Rotated click lost its down/up pair'
                    stop_control = next(n['text'] for n in nodes if n.get('text') in ['停止操作', 'Stop control'])
                    click(nodes, 'text', stop_control)
                    screenshot(prefix + '-passed')
                    print(f'PASS {prefix}: same process/bridge/selection, IME and control released, fresh normalized click coordinates; no remote OS input', flush=True)
            return
        if args.gesture_only:
            for compact, dark in [(False, False), (True, False), (False, True), (True, True)]:
                label = ('drag-compact' if compact else 'drag-wide') + ('-dark' if dark else '-light')
                start('remote-desktop-dark' if dark else 'remote-desktop', landscape=True)
                nodes = layout(label + '-start')
                if compact:
                    click(nodes, 'id', 'rd-preview-resize')
                    nodes = layout(label + '-resized')
                click(nodes, 'id', 'rd-preview-control')
                nodes = layout(label + '-ready')
                start_control = next((n['text'] for n in nodes if n.get('text') in ['开启操作', 'Start control']),
                                     'Start control' if any(n.get('text') == 'Mouse mode' for n in nodes) else '开启操作')
                click(nodes, 'text', start_control)
                nodes = layout(label + '-controlling')
                surface = next(n for n in nodes if n.get('id') == 'rd-input-surface')
                left, top, right, bottom = map(int, re.findall(r'-?\d+', surface['bounds']))
                cx, cy = str((left + right) // 2), str((top + bottom) // 2)
                run('shell', 'uitest', 'uiInput', 'click', cx, cy)
                centered = layout(label + '-centered')
                point = re.search(r'point=(\d+):(\d+)', diagnostic(centered))
                assert point and all(abs(int(value) - 500) <= 2 for value in point.groups()), 'Native direct coordinates are not local to the viewport'
                time.sleep(.4)
                # Both commands run on the device to keep the second touch
                # inside the production double-tap window, without host sleeps.
                run('shell', 'uitest', 'uiInput', 'click', cx, cy, '&&', 'uitest', 'uiInput', 'drag',
                    cx, cy, str(int(cx) + 96), cy, '200')
                dragged = layout(label + '-finished')
                text = diagnostic(dragged)
                assert 'left=3:3' in text, 'Native drag did not preserve its left-button pair: ' + text
                assert int(re.search(r'moves=(\d+)', text).group(1)) > 0, 'Native drag never moved while held'
                assert 'bridge=1 closed=0' in text and 'control=controlling' in text
                before_count = int(re.search(r'inputs=(\d+)', text).group(1))
                time.sleep(.4)
                run('shell', 'uitest', 'uiInput', 'longClick', cx, cy)
                text = diagnostic(layout(label + '-long-pressed'))
                assert int(re.search(r'inputs=(\d+)', text).group(1)) == before_count + 2, 'Native long press lost or duplicated its pair'
                assert 'left=3:3' in text, 'Native long press became a left click or held drag'
                assert 'bridge=1 closed=0' in text and 'control=controlling' in text
                screenshot(label + '-finished')
                print(f'PASS {label}: native click, double-tap drag and long press preserve button pairs; no OS input provider', flush=True)
            return
        for dark in ([] if args.keyboard_only else [False, True]):
            label = 'dark' if dark else 'light'
            start('remote-desktop-dark' if dark else 'remote-desktop', landscape=True)
            before = layout(f'{label}-wide')
            for _ in range(6):
                if 'bridge=1 ' in diagnostic(before):
                    break
                time.sleep(.3)
                before = layout(f'{label}-wide')
            assert 'bridge=1 closed=0' in diagnostic(before), diagnostic(before)
            width = int(re.search(r'width=(\d+)', diagnostic(before)).group(1))
            assert width >= 600, f'Need wide native window, got {width}vp'
            screenshot(f'{label}-wide')
            click(before, 'id', 'rd-preview-resize')
            compact = layout(f'{label}-compact')
            assert 'bridge=1 closed=0' in diagnostic(compact), 'Resize recreated the receiver'
            assert 'width=320' in diagnostic(compact), diagnostic(compact)
            screenshot(f'{label}-compact')
            click(compact, 'text', '1280 × 830')
            selected = layout(f'{label}-selected')
            assert 'selected=display-a:false' in diagnostic(selected), diagnostic(selected)
            click(selected, 'id', 'rd-preview-resize')
            resized = layout(f'{label}-resized')
            assert 'bridge=1 closed=0 selected=display-a:false' in diagnostic(resized), diagnostic(resized)
            click(resized, 'id', 'rd-preview-control')
            available = layout(f'{label}-control-available')
            start_control = next((node['text'] for node in available if node.get('text') in ['开启操作', 'Start control']),
                                 'Start control' if any(node.get('text') == 'Mouse mode' for node in available) else '开启操作')
            click(available, 'text', start_control)
            controlling = layout(f'{label}-controlling-wide')
            assert 'control=controlling' in diagnostic(controlling)
            assert not any(n.get('id') == 'rd-text-draft' for n in controlling), 'Keyboard editor should start collapsed'
            click(controlling, 'id', 'rd-keyboard-toggle')
            controlling = layout(f'{label}-keyboard-open')
            click(controlling, 'text', 'Enter')
            typed = layout(f'{label}-key-pair')
            click(typed, 'id', 'rd-keyboard-toggle')
            typed = layout(f'{label}-keyboard-closed')
            assert 'inputs=2' in diagnostic(typed), 'Native key press/release did not both reach the intent port'
            surface = next(n for n in typed if n.get('id') == 'rd-input-surface')
            left, top, right, bottom = map(int, re.findall(r'-?\d+', surface['bounds']))
            cx, cy = str((left + right) // 2), str((top + bottom) // 2)
            run('shell', 'uitest', 'uiInput', 'click', cx, cy)
            pointer = layout(f'{label}-pointer-click')
            assert 'inputs=4' in diagnostic(pointer), 'Native pointer click did not preserve its down/up pair'
            time.sleep(.4)
            run('shell', 'uitest', 'uiInput', 'longClick', cx, cy)
            typed = layout(f'{label}-pointer-long-press')
            assert 'inputs=6' in diagnostic(typed), 'Long press was duplicated or lost'
            screenshot(f'{label}-controlling-wide')
            click(typed, 'id', 'rd-preview-resize')
            compact_control = layout(f'{label}-control-resized')
            assert 'control=viewing' in diagnostic(compact_control), 'Width change retained control'
            assert 'bridge=1 closed=0' in diagnostic(compact_control), 'Control resize recreated media'
            click(compact_control, 'text', start_control)
            controlling_compact = layout(f'{label}-controlling-compact')
            assert 'control=controlling' in diagnostic(controlling_compact)
            screenshot(f'{label}-controlling-compact')
            stop_control = next(node['text'] for node in controlling_compact if node.get('text') in ['停止操作', 'Stop control'])
            click(controlling_compact, 'text', stop_control)
            released = layout(f'{label}-released')
            assert 'control=viewing' in diagnostic(released) and 'inputs=6' in diagnostic(released)
            for posture in ['compact', 'wide']:
                if posture == 'wide':
                    click(released, 'id', 'rd-preview-resize')
                    released = layout(f'{label}-pause-wide-ready')
                click(released, 'text', start_control)
                active = layout(f'{label}-{posture}-before-pause')
                click(active, 'id', 'rd-more-options')
                menu = layout(f'{label}-{posture}-pause-menu')
                click(menu, 'id', 'rd-pause-source')
                paused = layout(f'{label}-{posture}-paused')
                assert any(n.get('id') == 'rd-resume-source' for n in paused)
                assert 'control=viewing' in diagnostic(paused) and 'bridge=1 closed=0' in diagnostic(paused)
                assert 'inputs=6' in diagnostic(paused), 'Pause emitted input into a new lease'
                screenshot(f'{label}-{posture}-paused')
                click(paused, 'id', 'rd-resume-source', in_toolbar=True)
                released = layout(f'{label}-{posture}-resumed')
                assert 'control=viewing' in diagnostic(released) and 'bridge=1 closed=0' in diagnostic(released)
                assert any(n.get('text') == start_control for n in released), 'Resume must not reacquire operation'
                screenshot(f'{label}-{posture}-resumed')
            click(released, 'id', 'rd-preview-permission')
            permission = layout(f'{label}-permission')
            assert any('本机设置' in node.get('text', '') or 'local settings' in node.get('text', '') for node in permission)
            screenshot(f'{label}-permission')
            assert any(node.get('id') == 'rd-reconnect' for node in permission), 'Terminal state has no explicit reconnect action'
            click(permission, 'id', 'rd-reconnect')
            retried = layout(f'{label}-manual-reconnect')
            assert any(node.get('text') in ['选择显示器', 'Choose a display'] for node in retried), 'Manual reconnect did not return to display selection'
            assert 'bridge=1 closed=0' in diagnostic(retried), 'Manual reconnect replaced the native bridge'
            click(retried, 'id', 'rd-preview-permission')
            permission = layout(f'{label}-permission-again')
            disconnect = next(node['text'] for node in permission if node.get('text') in ['返回', 'Back'])
            click(permission, 'text', disconnect)
            stopped = layout(f'{label}-stopped')
            assert any(node.get('id') == 'rd-preview-stopped' for node in stopped)
            assert 'closed=1' in diagnostic(stopped), diagnostic(stopped)
            print(f'PASS {label}: wide/compact/live resize, single bridge, scoped selection, native control/key/pointer intent pairs, resize release, pause/resume without control recovery, local trust copy and close', flush=True)
        if args.layout_only:
            return
        for landscape, compact, dark in [(True, False, False), (True, True, False), (True, False, True), (True, True, True), (False, False, False)]:
            prefix = ('keyboard-compact' if compact else 'keyboard-wide' if landscape else 'keyboard-portrait') + ('-dark' if dark else '-light')
            start('remote-desktop-dark' if dark else 'remote-desktop', landscape=landscape)
            nodes = layout(prefix + '-start')
            pane = next(n for n in nodes if n.get('id') == 'rd-preview-pane')
            pl, pt, pr, pb = map(int, re.findall(r'-?\d+', pane['bounds']))
            assert (pr-pl > pb-pt) if landscape else (pb-pt > pr-pl), 'Preview orientation does not match the evidence label'
            if compact:
                click(nodes, 'id', 'rd-preview-resize')
                nodes = layout(prefix + '-resized')
            click(nodes, 'id', 'rd-preview-control')
            nodes = layout(prefix + '-ready')
            start_control = next(n['text'] for n in nodes if n.get('text') in ['开启操作', 'Start control'])
            click(nodes, 'text', start_control)
            nodes = layout(prefix + '-controlling')
            assert 'inputs=0' in diagnostic(nodes)
            click(nodes, 'id', 'rd-keyboard-toggle')
            for _ in range(8):
                nodes = layout(prefix + '-keyboard-launched')
                if any(n.get('id') == 'KeyboardCanvas' for n in nodes):
                    break
                time.sleep(.2)
            assert any(n.get('id') == 'KeyboardCanvas' for n in nodes), 'Virtual keyboard did not attach to the native IME'
            assert not any(n.get('id') in ['rd-text-draft', 'rd-text-submit'] for n in nodes), 'A local composer replaced the remote keyboard'
            dock = next(n for n in nodes if n.get('id') == 'rd-control-dock')
            surface = next(n for n in nodes if n.get('id') == 'rd-input-surface')
            dl, dt, dr, db = map(int, re.findall(r'-?\d+', dock['bounds']))
            sl, st, sr, sb = map(int, re.findall(r'-?\d+', surface['bounds']))
            assert sr > sl and sb > st and sb <= dt, 'Keyboard covers or collapses the media surface'
            toggle = next(n for n in nodes if n.get('id') == 'rd-keyboard-toggle')
            tl, tt, tr, tb = map(int, re.findall(r'-?\d+', toggle['bounds']))
            assert dl <= tl < tr <= dr and dt <= tt < tb <= db, 'Keyboard toggle clipped outside the dock'
            screenshot(prefix + '-open')
            canvas = next(n for n in nodes if n.get('id') == 'KeyboardCanvas')
            left, top, right, bottom = map(int, re.findall(r'-?\d+', canvas['bounds']))
            # Observed native QWERTY canvas: Q/W/E, then Space to confirm any
            # IME preedit, then native Backspace and Return. This is a no-account
            # intent sink; no remote OS receives these disposable test characters.
            for x, y in [(0.05, 0.125), (0.15, 0.125), (0.25, 0.125), (0.5, 0.875), (0.95, 0.625), (0.95, 0.875)]:
                run('shell', 'uitest', 'uiInput', 'click', str(round(left + (right-left)*x)), str(round(top + (bottom-top)*y)))
                time.sleep(.1)
            nodes = layout(prefix + '-typed')
            assert not any('虚拟键盘已暂停' in n.get('text', '') or 'remote keyboard paused' in n.get('text', '') for n in nodes)
            click(nodes, 'id', 'rd-keyboard-toggle')
            collapsed = layout(prefix + '-collapsed')
            receipt = diagnostic(collapsed)
            assert 'control=controlling' in receipt and 'bridge=1 closed=0' in receipt, receipt
            text = re.search(r'text=(\d+):(\d+)', receipt)
            keys = re.search(r'keys=(\d+):(\d+)', receipt)
            assert text and int(text[1]) > 0 and int(text[2]) > 0, 'Native confirmed text did not immediately reach remote input intents: ' + receipt
            assert keys and int(keys[1]) >= 2 and keys[1] == keys[2] and 'usage=40' in receipt, 'Native Backspace/Return did not emit paired remote keys: ' + receipt
            assert not any(n.get('id') == 'rd-virtual-keyboard' for n in collapsed)
            screenshot(prefix + '-collapsed')
            click(collapsed, 'id', 'rd-more-options')
            options = layout(prefix + '-options')
            assert any(n.get('text') in ['鼠标模式', 'Mouse mode'] for n in options), 'Direct touch is not the default mode'
            # Native Scroll omits offscreen children from the accessibility
            # tree. Reveal the final action before checking its presence.
            click(options, 'text', '断开连接' if start_control == '开启操作' else 'Disconnect',
                  in_toolbar=True, activate=False)
            options = layout(prefix + '-options-scrolled')
            assert any(n.get('text') in ['断开连接', 'Disconnect'] for n in options)
            screenshot(prefix + '-options')
            print(f'PASS {prefix}: actual IME text commits without a send step, native Backspace/Return pair, fixed dock, receiver/control context retained; no remote OS injection', flush=True)
    finally:
        try:
            # Preferred orientation changes outlive the preview window on some
            # devices. Restore it through the DEBUG fixture, then start a new
            # ordinary window with the App's system-following manifest policy.
            if original_landscape is not None:
                start('remote-desktop', landscape=original_landscape)
        finally:
            start()
        if original_landscape is not None:
            restored = layout('restored-orientation')
            root = next(n for n in restored if n.get('type') == 'root')
            left, top, right, bottom = map(int, re.findall(r'-?\d+', root['bounds']))
            assert (right-left > bottom-top) == original_landscape, 'Test left the ordinary App in a different orientation'
            assert not any(n.get('id', '').startswith('rd-preview') for n in restored), 'Test preview survived cleanup'
            (output / 'restored-orientation.json').unlink()
            print('PASS cleanup: ordinary App restored in its initial orientation', flush=True)


if __name__ == '__main__':
    main()
