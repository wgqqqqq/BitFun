import React, { useState, useCallback, useMemo, useEffect } from 'react';
import { Settings, FolderOpen, Home, FolderPlus, Info, Menu, PanelBottom } from 'lucide-react';
import { PanelLeftIcon, PanelRightIcon } from './PanelIcons';
import { open } from '@tauri-apps/plugin-dialog';
import { useTranslation } from 'react-i18next';
import { useWorkspaceContext } from '../../../infrastructure/contexts/WorkspaceContext';
import { useViewMode } from '../../../infrastructure/contexts/ViewModeContext';
import './Header.scss';

import { Button, WindowControls, Tooltip } from '@/component-library';
import { WorkspaceManager } from '../../../tools/workspace';
import { CurrentSessionTitle, useToolbarModeContext } from '../../../flow_chat'; // Imported from flow_chat module
import { createConfigCenterTab } from '@/shared/utils/tabUtils';
import { workspaceAPI } from '@/infrastructure/api';
import { NewProjectDialog } from '../NewProjectDialog';
import { AboutDialog } from '../AboutDialog';
import { GlobalSearch } from './GlobalSearch';
import { AgentOrb } from './AgentOrb';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('Header');

interface HeaderProps {
  className?: string;
  onMinimize: () => void;
  onMaximize: () => void;
  onClose: () => void;
  onHome: () => void;
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
  leftPanelCollapsed: boolean;
  rightPanelCollapsed: boolean;
  onCreateSession?: () => void; // Callback to create a FlowChat session
  isMaximized?: boolean; // Whether the window is maximized
}

/**
 * Application header component.
 * Includes title bar, toolbar, and window controls.
 */
const Header: React.FC<HeaderProps> = ({
  className = '',
  onMinimize,
  onMaximize,
  onClose,
  onHome,
  onToggleLeftPanel,
  onToggleRightPanel,
  leftPanelCollapsed,
  rightPanelCollapsed,
  onCreateSession,
  isMaximized = false
}) => {
  const { t } = useTranslation('common');
  const [showWorkspaceStatus, setShowWorkspaceStatus] = useState(false);
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false);
  const [showAboutDialog, setShowAboutDialog] = useState(false);
  const [showHorizontalMenu, setShowHorizontalMenu] = useState(false);
  const [menuPinned, setMenuPinned] = useState(false); // Whether the menu is pinned open
  const [isOrbHovered, setIsOrbHovered] = useState(false); // Orb hover state

  // macOS Desktop (Tauri): use native titlebar traffic lights (hide custom window controls)
  const isMacOS = useMemo(() => {
    const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;
    return (
      isTauri &&
      typeof navigator !== 'undefined' &&
      typeof navigator.platform === 'string' &&
      navigator.platform.toUpperCase().includes('MAC')
    );
  }, []);
  
  // View mode
  const { toggleViewMode, isAgenticMode, isEditorMode } = useViewMode();
  
	// Toolbar mode
	const { enableToolbarMode } = useToolbarModeContext();

	// Track last mousedown time to detect double-clicks
	const lastMouseDownTimeRef = React.useRef<number>(0);

	  // Cross-platform frameless window: use startDragging() for titlebar drag (avoid data-tauri-drag-region)
	  const handleHeaderMouseDown = useCallback((e: React.MouseEvent) => {
			const now = Date.now();
			const timeSinceLastMouseDown = now - lastMouseDownTimeRef.current;
			lastMouseDownTimeRef.current = now;

		// Left-click only
		if (e.button !== 0) return;

		const target = e.target as HTMLElement | null;
		if (!target) return;

		// Do not start drag on interactive elements
		if (
			target.closest(
				'button, input, textarea, select, a, [role="button"], [contenteditable="true"], .window-controls, .bitfun-immersive-panel-toggles, .agent-orb-wrapper, .agent-orb-logo'
			)
		) {
			return;
		}

		// If this is a potential double-click (<500ms), skip drag to allow the dblclick event
		if (timeSinceLastMouseDown < 500 && timeSinceLastMouseDown > 50) {
			return;
		}

			void (async () => {
				try {
					const { getCurrentWindow } = await import('@tauri-apps/api/window');
					await getCurrentWindow().startDragging();
			} catch (error) {
				// May fail outside Tauri (e.g., web preview); ignore silently
				log.debug('startDragging failed', error);
			}
			})();
		}, []);

		// Double-click empty titlebar area: match WindowControls maximize behavior
		const handleHeaderDoubleClick = useCallback((e: React.MouseEvent) => {
		const target = e.target as HTMLElement | null;
		if (!target) return;

		if (
			target.closest(
				'button, input, textarea, select, a, [role="button"], [contenteditable="true"], .window-controls, .bitfun-immersive-panel-toggles, .agent-orb-wrapper, .agent-orb-logo'
			)
		) {
			return;
		}

			onMaximize();
		}, [onMaximize]);
  
  const {
    hasWorkspace,
    workspacePath,
    openWorkspace
  } = useWorkspaceContext();

  // Open existing project
  const handleOpenProject = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: t('header.selectProjectDirectory')
      }) as string;

      if (selected && typeof selected === 'string') {
        await openWorkspace(selected);
        log.info('Opening workspace', { path: selected });
      }
    } catch (error) {
      log.error('Failed to open workspace', error);
    }
  }, [openWorkspace]);

  // Open the new project dialog
  const handleNewProject = useCallback(() => {
    setShowNewProjectDialog(true);
  }, []);

  // Confirm creation of a new project
  const handleConfirmNewProject = useCallback(async (parentPath: string, projectName: string) => {
    const normalizedParentPath = parentPath.replace(/\\/g, '/');
    const newProjectPath = `${normalizedParentPath}/${projectName}`;
    
    log.info('Creating new project', { parentPath, projectName, fullPath: newProjectPath });
    
    try {
      // Create directory
      await workspaceAPI.createDirectory(newProjectPath);
      
      // Open the newly created project
      await openWorkspace(newProjectPath);
      log.info('New project opened', { path: newProjectPath });
      
    } catch (error) {
      log.error('Failed to create project', error);
      throw error; // Re-throw so the dialog can display the error
    }
  }, [openWorkspace]);

  // Return to home
  const handleGoHome = useCallback(() => {
    onHome();
  }, [onHome]);

  // Open the About dialog
  const handleShowAbout = useCallback(() => {
    setShowAboutDialog(true);
  }, []);

  // Orb menu click: toggle pinned open/close
  const handleMenuClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setMenuPinned(!menuPinned);
    setShowHorizontalMenu(!menuPinned);
  }, [menuPinned]);

  // Orb hover: enable header glow
  const handleOrbHoverEnter = useCallback(() => {
    setIsOrbHovered(true);
  }, []);

  const handleOrbHoverLeave = useCallback(() => {
    setIsOrbHovered(false);
  }, []);

  const agentOrbNode = (
    <div
      className="agent-orb-wrapper"
      onMouseEnter={handleOrbHoverEnter}
      onMouseLeave={handleOrbHoverLeave}
    >
      <AgentOrb isAgenticMode={isAgenticMode} onToggle={toggleViewMode} />
    </div>
  );

  // macOS menubar events (Tauri native menubar)
  useEffect(() => {
    if (!isMacOS) return;

    let unlistenFns: Array<() => void> = [];

    void (async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event');

        unlistenFns.push(
          await listen('bitfun_menu_open_project', () => {
            void handleOpenProject();
          })
        );
        unlistenFns.push(
          await listen('bitfun_menu_new_project', () => {
            handleNewProject();
          })
        );
        unlistenFns.push(
          await listen('bitfun_menu_go_home', () => {
            handleGoHome();
          })
        );
        unlistenFns.push(
          await listen('bitfun_menu_about', () => {
            handleShowAbout();
          })
        );
      } catch (error) {
        // May fail outside Tauri (e.g., web preview); ignore silently
        log.debug('menubar listen failed', error);
      }
    })();

    return () => {
      unlistenFns.forEach((fn) => fn());
      unlistenFns = [];
    };
  }, [isMacOS, handleOpenProject, handleNewProject, handleGoHome, handleShowAbout]);

  // Menu hover: expand
  const handleMenuHoverEnter = useCallback(() => {
    if (!menuPinned) {
      setShowHorizontalMenu(true);
    }
  }, [menuPinned]);

  const handleMenuHoverLeave = useCallback(() => {
    if (!menuPinned) {
      setShowHorizontalMenu(false);
    }
  }, [menuPinned]);

  // Horizontal menu items (no separators)
  const horizontalMenuItems = [
    {
      id: 'open-project',
      label: t('header.openProject'),
      icon: <FolderOpen size={14} />,
      onClick: handleOpenProject
    },
    {
      id: 'new-project',
      label: t('header.newProject'),
      icon: <FolderPlus size={14} />,
      onClick: handleNewProject
    },
    {
      id: 'go-home',
      label: t('header.goHome'),
      icon: <Home size={14} />,
      onClick: handleGoHome,
      testId: 'header-home-btn'
    },
    {
      id: 'about',
      label: t('header.about'),
      icon: <Info size={14} />,
      onClick: handleShowAbout
    }
  ];

		return (
			<>
						<header 
							className={`${className} ${isMacOS ? 'bitfun-app-header--macos-native-titlebar' : ''} ${isOrbHovered ? (isAgenticMode ? 'bitfun-header--orb-glow-agentic' : 'bitfun-header--orb-glow-editor') : ''}`} 
							data-testid="header-container"
							onMouseDown={handleHeaderMouseDown}
							onDoubleClick={handleHeaderDoubleClick}
						>
						<div className="bitfun-header-left">
              {/* macOS: move items to system menubar; hide custom menu button; move toggle to right */}
              {!isMacOS && (
                <div className="bitfun-menu-container">
                  {/* Logo: used for mode switch with independent hover effect */}
                  {agentOrbNode}
                  
                  {/* Menu area: hoverable region to keep menu open on pointer move */}
                  <div 
                    className="bitfun-menu-expand-area"
                    onMouseEnter={handleMenuHoverEnter}
                    onMouseLeave={handleMenuHoverLeave}
                  >
                    {/* Orb menu button: expand on hover */}
                    <Tooltip content={menuPinned ? t('header.closeMenu') : t('header.openMenu')} placement="bottom">
                      <button
                        className={`bitfun-agent-menu-btn ${menuPinned ? 'bitfun-agent-menu-btn--pinned' : ''}`}
                        onClick={handleMenuClick}
                      >
                        <Menu size={14} />
                      </button>
                    </Tooltip>

                    {/* Expanded horizontal menu items */}
                    <div 
                      className={`bitfun-horizontal-menu ${showHorizontalMenu ? 'bitfun-horizontal-menu--visible' : ''}`}
                    >
                      {horizontalMenuItems.map((item, index) => (
                        <React.Fragment key={item.id}>
                          {index > 0 && <div className="bitfun-horizontal-menu-divider" />}
                          <button
                            className="bitfun-horizontal-menu-item"
                            onClick={() => {
                              item.onClick();
                              // Close the menu after item click
                              setShowHorizontalMenu(false);
                              setMenuPinned(false);
                            }}
                            style={{
                              transitionDelay: showHorizontalMenu ? `${index * 40}ms` : '0ms'
                            }}
                            data-testid={(item as any).testId}
                          >
                            {item.icon}
                            <span className="bitfun-horizontal-menu-item__label">{item.label}</span>
                          </button>
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                </div>
              )}
	        </div>
						
						<div 
							className="bitfun-header-center"
					>
						{/* Current session title: only in Agentic mode */}
						{isAgenticMode && <CurrentSessionTitle onCreateSession={onCreateSession} />}
						
          {/* Global search: only in Editor mode */}
          {isEditorMode && <GlobalSearch />}
        </div>
        
        <div className="bitfun-header-right">
          {/* Immersive panel toggles: unified icon */}
          <div className="bitfun-immersive-panel-toggles">
            <button
              className={`bitfun-immersive-toggle-btn bitfun-immersive-toggle-btn--unified ${
                !leftPanelCollapsed && rightPanelCollapsed ? 'bitfun-immersive-toggle-btn--left-fill' : 
                leftPanelCollapsed && !rightPanelCollapsed ? 'bitfun-immersive-toggle-btn--right-fill' :
                !leftPanelCollapsed && !rightPanelCollapsed ? 'bitfun-immersive-toggle-btn--both-expanded' :
                'bitfun-immersive-toggle-btn--both-collapsed'
              }`}
            >
              {/* Left indicator */}
              <Tooltip content={leftPanelCollapsed ? t('header.expandLeftPanel') : t('header.collapseLeftPanel')} placement="bottom">
                <span 
                  className={`bitfun-panel-indicator bitfun-panel-indicator--left ${!leftPanelCollapsed ? 'active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleLeftPanel();
                  }}
                >
                  <PanelLeftIcon size={14} filled={!leftPanelCollapsed} />
                </span>
              </Tooltip>
              
              {/* Divider */}
              <span className="bitfun-panel-divider"></span>
              
              {/* Right indicator */}
              <Tooltip content={rightPanelCollapsed ? t('header.expandRightPanel') : t('header.collapseRightPanel')} placement="bottom">
                <span 
                  className={`bitfun-panel-indicator bitfun-panel-indicator--right ${!rightPanelCollapsed ? 'active' : ''}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onToggleRightPanel();
                  }}
                >
                  <PanelRightIcon size={14} filled={!rightPanelCollapsed} />
                </span>
              </Tooltip>
              
              {/* Toolbar mode toggle: only in Agentic mode */}
              {isAgenticMode && (
                <>
                  <span className="bitfun-panel-divider"></span>
                  <Tooltip content={t('header.switchToToolbar')}>
                    <span 
                      className="bitfun-panel-indicator bitfun-panel-indicator--toolbar"
                      onClick={(e) => {
                        e.stopPropagation();
                        enableToolbarMode();
                      }}
                    >
                      <PanelBottom size={14} />
                    </span>
                  </Tooltip>
                </>
              )}
            </button>
          </div>
	          
	          {/* Config center button */}
	          <Tooltip content={t('header.configCenter')}>
            <Button
              variant="ghost"
              size="small"
              iconOnly
              data-testid="header-config-btn"
              onClick={() => {
                createConfigCenterTab('models', 'agent');
              }}
            >
              <Settings size={14} />
            </Button>
	          </Tooltip>

            {/* macOS: move Agentic/Editor toggle to the far right (after config button) */}
            {isMacOS && agentOrbNode}
		          
		          {/* Window controls (macOS uses native traffic lights; hide custom buttons) */}
		          {!isMacOS && (
		            <WindowControls
	              onMinimize={onMinimize}
	              onMaximize={onMaximize}
	              onClose={onClose}
	              isMaximized={isMaximized}
	              data-testid-minimize="header-minimize-btn"
	              data-testid-maximize="header-maximize-btn"
	              data-testid-close="header-close-btn"
	            />
	          )}
	        </div>
	      </header>



      {/* New project dialog */}
      <NewProjectDialog
        isOpen={showNewProjectDialog}
        onClose={() => setShowNewProjectDialog(false)}
        onConfirm={handleConfirmNewProject}
        defaultParentPath={hasWorkspace ? workspacePath : undefined}
      />

      {/* About dialog */}
      <AboutDialog
        isOpen={showAboutDialog}
        onClose={() => setShowAboutDialog(false)}
      />

      {/* Workspace status modal */}
      <WorkspaceManager 
        isVisible={showWorkspaceStatus}
        onClose={() => setShowWorkspaceStatus(false)}
        onWorkspaceSelect={(workspace: any) => {
          log.debug('Workspace selected', { workspace });
          // Workspace selection is handled in the useWorkspace hook
        }}
      />
    </>
  );
};

export default Header;
