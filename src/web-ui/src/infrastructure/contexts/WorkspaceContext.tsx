 

import React, { createContext, useContext, useEffect, useState, useCallback, useRef, ReactNode } from 'react';
import { workspaceManager, WorkspaceState, WorkspaceEvent } from '../services/business/workspaceManager';
import { WorkspaceInfo } from '../../shared/types';
import { createLogger } from '@/shared/utils/logger';

const log = createLogger('WorkspaceProvider');


interface WorkspaceContextValue extends WorkspaceState {
  
  openWorkspace: (path: string) => Promise<WorkspaceInfo>;
  closeWorkspace: () => Promise<void>;
  switchWorkspace: (workspace: WorkspaceInfo) => Promise<WorkspaceInfo>;
  scanWorkspaceInfo: () => Promise<WorkspaceInfo | null>;
  refreshRecentWorkspaces: () => Promise<void>;
  
  
  hasWorkspace: boolean;
  workspaceName: string;
  workspacePath: string;
}


const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

// Provider Props
interface WorkspaceProviderProps {
  children: ReactNode;
}

 
export const WorkspaceProvider: React.FC<WorkspaceProviderProps> = ({ children }) => {
  
  const [state, setState] = useState<WorkspaceState>(() => {
    try {
      return workspaceManager.getState();
    } catch (error) {
      log.warn('WorkspaceManager not initialized, using default state', error);
      return {
        currentWorkspace: null,
        recentWorkspaces: [],
        loading: false,
        error: null,
      };
    }
  });
  
  
  const isInitializedRef = useRef(false);

  
  useEffect(() => {
    const removeListener = workspaceManager.addEventListener((event: WorkspaceEvent) => {
      
      const newState = workspaceManager.getState();

      
      setState(prevState => {
        const isChanged = (
          prevState.currentWorkspace?.id !== newState.currentWorkspace?.id ||
          prevState.currentWorkspace?.rootPath !== newState.currentWorkspace?.rootPath ||
          prevState.loading !== newState.loading ||
          prevState.error !== newState.error ||
          prevState.recentWorkspaces.length !== newState.recentWorkspaces.length
        );

        if (isChanged) {
          return newState;
        }
        return prevState;
      });
    });

    
    return () => {
      removeListener();
    };
  }, []);

  
  useEffect(() => {
    const initializeWorkspace = async () => {
      if (isInitializedRef.current) {
        return;
      }
      
      try {
        isInitializedRef.current = true;
        
        
        setState(prev => ({ ...prev, loading: true }));
        
        await workspaceManager.initialize();
        
        const finalState = workspaceManager.getState();
        
        
        setState(finalState);
      } catch (error) {
        log.error('Failed to initialize workspace state', error);
        isInitializedRef.current = false;
        setState(prev => ({ ...prev, loading: false, error: String(error) }));
      }
    };

    initializeWorkspace();
  }, []); 

  
  const openWorkspace = useCallback(async (path: string): Promise<WorkspaceInfo> => {
    return await workspaceManager.openWorkspace(path);
  }, []);

  const closeWorkspace = useCallback(async (): Promise<void> => {
    return await workspaceManager.closeWorkspace();
  }, []);

  const switchWorkspace = useCallback(async (workspace: WorkspaceInfo): Promise<WorkspaceInfo> => {
    return await workspaceManager.switchWorkspace(workspace);
  }, []);

  const scanWorkspaceInfo = useCallback(async (): Promise<WorkspaceInfo | null> => {
    return await workspaceManager.scanWorkspaceInfo();
  }, []);

  const refreshRecentWorkspaces = useCallback(async (): Promise<void> => {
    return await workspaceManager.refreshRecentWorkspaces();
  }, []);

  
  const hasWorkspace = !!state.currentWorkspace;
  const workspaceName = state.currentWorkspace?.name || '';
  const workspacePath = state.currentWorkspace?.rootPath || '';

  const contextValue: WorkspaceContextValue = {
    
    ...state,
    
    
    openWorkspace,
    closeWorkspace,
    switchWorkspace,
    scanWorkspaceInfo,
    refreshRecentWorkspaces,
    
    
    hasWorkspace,
    workspaceName,
    workspacePath,
  };

  return (
    <WorkspaceContext.Provider value={contextValue}>
      {children}
    </WorkspaceContext.Provider>
  );
};

 
export const useWorkspaceContext = (): WorkspaceContextValue => {
  const context = useContext(WorkspaceContext);
  
  if (!context) {
    throw new Error('useWorkspaceContext must be used within a WorkspaceProvider');
  }
  
  return context;
};

 
export const useCurrentWorkspace = () => {
  const { currentWorkspace, loading, error, hasWorkspace, workspaceName, workspacePath } = useWorkspaceContext();
  
  
  return {
    workspace: currentWorkspace,
    loading,
    error,
    hasWorkspace,
    workspaceName,
    workspacePath,
  };
};

 
export const useWorkspaceEvents = (
  onWorkspaceOpened?: (workspace: WorkspaceInfo) => void,
  onWorkspaceClosed?: (workspaceId: string) => void,
  onWorkspaceSwitched?: (workspace: WorkspaceInfo) => void,
  onWorkspaceUpdated?: (workspace: WorkspaceInfo) => void
) => {
  useEffect(() => {
    const removeListener = workspaceManager.addEventListener((event: WorkspaceEvent) => {
      switch (event.type) {
        case 'workspace:opened':
          onWorkspaceOpened?.(event.workspace);
          break;
        case 'workspace:closed':
          onWorkspaceClosed?.(event.workspaceId);
          break;
        case 'workspace:switched':
          onWorkspaceSwitched?.(event.workspace);
          break;
        case 'workspace:updated':
          onWorkspaceUpdated?.(event.workspace);
          break;
      }
    });

    return removeListener;
  }, [onWorkspaceOpened, onWorkspaceClosed, onWorkspaceSwitched, onWorkspaceUpdated]);
};


export { WorkspaceContext };
