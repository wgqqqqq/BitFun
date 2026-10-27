import { useEffect, useRef, useState } from 'react';
import { Button, Field, Textarea } from '@openbitfun/ui';
import { useI18n } from '@/infrastructure/i18n';
import { DesktopInputPolicy } from '@/infrastructure/remote-desktop/DesktopInputPolicy';
import type { RemoteDesktopController } from '@/infrastructure/remote-desktop/RemoteDesktopController';

interface Props {
  owner: RemoteDesktopController;
  renderer: string;
  generation: string;
  width: number;
  height: number;
}

/** DOM leaf. Only the focused video surface forwards physical keyboard input;
 * toolbar and editor keys remain local. No Tauri or account API lives here. */
export function RemoteDesktopInputSurface(props: Props) {
  const { t } = useI18n('common');
  const surface = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = surface.current; if (!element) return;
    let active = true;
    const policy = new DesktopInputPolicy({ input: message => props.owner.input(message),
      unsupported: binding => props.owner.inputUnsupported(binding),
      release: binding => { active = false; props.owner.releaseControl(binding); } });
    const configure = () => {
      if (!active) return;
      const rect = element.getBoundingClientRect();
      policy.configure({ renderer: props.renderer, generation: props.generation,
        left: rect.left, top: rect.top, width: rect.width, height: rect.height, sourceWidth: props.width, sourceHeight: props.height });
    };
    const pointer = (event: PointerEvent) => {
      if (!active) return; configure(); if (!active) return;
      event.preventDefault(); event.stopPropagation();
      if (event.type === 'pointermove') policy.move(event.pointerId, event.clientX, event.clientY, event.buttons);
      else if (event.type === 'pointerdown') {
        element.focus({ preventScroll: true });
        policy.button(event.pointerId, event.button, true, event.clientX, event.clientY);
        try { element.setPointerCapture(event.pointerId); } catch { policy.cancel(); }
      } else {
        policy.button(event.pointerId, event.button, false, event.clientX, event.clientY);
        if (event.buttons === 0 && element.hasPointerCapture(event.pointerId)) element.releasePointerCapture(event.pointerId);
      }
    };
    const cancel = () => policy.cancel();
    const lost = () => policy.lostCapture();
    const blur = (event: FocusEvent) => {
      const view = element.closest('[data-openbitfun-component="remote-desktop-viewer"][data-openbitfun-part="root"]');
      if (event.relatedTarget instanceof Node && view?.contains(event.relatedTarget)) policy.clearHeld();
      else policy.cancel();
    };
    const key = (event: KeyboardEvent) => {
      if (!active) return;
      event.preventDefault(); event.stopPropagation();
      policy.key(event.code, event.type === 'keydown', event.isComposing || event.keyCode === 229);
    };
    const wheel = (event: WheelEvent) => {
      if (!active) return; configure(); if (!active) return;
      event.preventDefault(); event.stopPropagation();
      const height = Number.parseFloat(getComputedStyle(element).lineHeight);
      policy.wheel(event.clientX, event.clientY, event.deltaX, event.deltaY, event.deltaMode, Number.isFinite(height) ? height : 16);
    };
    const contextMenu = (event: MouseEvent) => { event.preventDefault(); event.stopPropagation(); };
    configure();
    const resize = new ResizeObserver(configure); resize.observe(element);
    element.addEventListener('pointerdown', pointer); element.addEventListener('pointermove', pointer); element.addEventListener('pointerup', pointer);
    element.addEventListener('pointercancel', cancel); element.addEventListener('lostpointercapture', lost);
    element.addEventListener('blur', blur); element.addEventListener('keydown', key); element.addEventListener('keyup', key);
    element.addEventListener('wheel', wheel, { passive: false }); element.addEventListener('contextmenu', contextMenu);
    window.addEventListener('blur', cancel);
    return () => {
      active = false; resize.disconnect(); policy.cancel();
      element.removeEventListener('pointerdown', pointer); element.removeEventListener('pointermove', pointer); element.removeEventListener('pointerup', pointer);
      element.removeEventListener('pointercancel', cancel); element.removeEventListener('lostpointercapture', lost);
      element.removeEventListener('blur', blur); element.removeEventListener('keydown', key); element.removeEventListener('keyup', key);
      element.removeEventListener('wheel', wheel); element.removeEventListener('contextmenu', contextMenu); window.removeEventListener('blur', cancel);
    };
  }, [props.owner, props.renderer, props.generation, props.width, props.height]);
  return <div ref={surface} tabIndex={0} role="application" aria-label={t('remoteDesktop.viewerInputSurface')}
    data-shortcut-exclusive="true"
    className="remote-desktop-viewer__input" data-openbitfun-component="remote-desktop-viewer" data-openbitfun-part="input" />;
}

/** Local composition and explicit submit, keyed by renderer/lease by the owner. */
export function RemoteDesktopTextComposer({ owner, renderer, generation }: Pick<Props, 'owner' | 'renderer' | 'generation'>) {
  const { t } = useI18n('common');
  const [draft, setDraft] = useState('');
  const [composing, setComposing] = useState(false);
  const valid = draft.length > 0 && !draft.includes('\0') && new TextEncoder().encode(draft).length <= 4096;
  return <div className="remote-desktop-viewer__composer" data-openbitfun-component="remote-desktop-viewer" data-openbitfun-part="composer">
    <Field label={t('remoteDesktop.viewerTextDraft')} controlWidth="fill">
      <Textarea value={draft} maxLength={1024} rows={2} resize="none" layout="fill" aria-label={t('remoteDesktop.viewerTextDraft')}
        onValueChange={setDraft} onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)} />
    </Field>
    <Button size="sm" disabled={!valid || composing} onClick={() => {
      if (!valid || composing) return;
      const text = draft; setDraft('');
      owner.input({ renderer_id: renderer, control_generation: generation, kind: 'text_commit', body: { text } });
    }}>{t('remoteDesktop.viewerSendText')}</Button>
  </div>;
}
