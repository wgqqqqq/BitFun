/** A focused surface may own physical keys before app capture handlers.
 * Toolbars/editors outside that surface keep their normal local shortcuts. */
export function isExclusiveShortcutTarget(event: KeyboardEvent): boolean {
  if (!(event.target instanceof Element)) return false;
  const owner = event.target.closest('[data-shortcut-exclusive="true"]');
  return !!owner && owner.contains(owner.ownerDocument.activeElement);
}
