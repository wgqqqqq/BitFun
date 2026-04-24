import React from 'react';
import GenerativeWidgetFrame, {
  type WidgetContextMenuMessage,
  type WidgetMessage,
} from './GenerativeWidgetFrame';
import { handleWidgetBridgeEvent } from './widgetInteraction';
import { useGenerativeWidgetPromptMenu } from './useGenerativeWidgetPromptMenu';
import { useContextMenuStore } from '@/shared/context-menu-system';
import './GenerativeWidgetPanel.scss';

export interface GenerativeWidgetPanelProps {
  title?: string;
  widgetId?: string;
  widgetCode?: string;
}

export const GenerativeWidgetPanel: React.FC<GenerativeWidgetPanelProps> = ({
  title,
  widgetId,
  widgetCode,
}) => {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const openPromptMenu = useGenerativeWidgetPromptMenu('panel');
  const hideMenu = useContextMenuStore(state => state.hideMenu);
  const [selectionRevision, setSelectionRevision] = React.useState(0);
  const [menuSelectionActive, setMenuSelectionActive] = React.useState(false);

  const handleWidgetEvent = React.useCallback((event: WidgetMessage) => {
    if (event.type === 'bitfun-widget:context-menu') {
      setMenuSelectionActive(true);
      openPromptMenu(event as WidgetContextMenuMessage, containerRef.current);
      return;
    }
    if (event.type === 'bitfun-widget:selection-cleared') {
      setMenuSelectionActive(false);
      hideMenu();
      return;
    }
    if (
      event.type === 'bitfun-widget:ready' ||
      event.type === 'bitfun-widget:resize' ||
      event.type === 'bitfun-widget:clear-selection'
    ) {
      return;
    }
    handleWidgetBridgeEvent(event, 'panel');
  }, [hideMenu, openPromptMenu]);

  React.useEffect(() => {
    if (!menuSelectionActive) {
      return;
    }

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      setMenuSelectionActive(false);
      hideMenu();
      setSelectionRevision((value) => value + 1);
    };

    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [hideMenu, menuSelectionActive]);

  if (!widgetCode) {
    return (
      <div className="bitfun-generative-widget-panel bitfun-generative-widget-panel--empty">
        <div className="bitfun-generative-widget-panel__empty-copy">
          No widget content available.
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} className="bitfun-generative-widget-panel">
      <GenerativeWidgetFrame
        widgetId={widgetId || `panel-widget-${Date.now()}`}
        title={title}
        widgetCode={widgetCode}
        executeScripts={true}
        selectionRevision={selectionRevision}
        onWidgetEvent={handleWidgetEvent}
      />
    </div>
  );
};

export default GenerativeWidgetPanel;
