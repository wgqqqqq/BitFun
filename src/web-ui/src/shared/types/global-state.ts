/**
 * Global state and app-level API types.
 */
import { globalAPI } from '@/infrastructure/api';
import { workspaceAPI } from '@/infrastructure/api';
import { createLogger } from '../utils/logger';

const logger = createLogger('GlobalStateAPI');


export enum AppStatus {
  Initializing = 'initializing',
  Running = 'running',
  Processing = 'processing',
  Idle = 'idle',
  Error = 'error',
}


export interface UserSettings {
  theme: string;
  language: string;
  autoSaveInterval: number;
  maxCachedGraphs: number;
  debugMode: boolean;
  customSettings: Record<string, any>;
}


export interface ApplicationState {
  appId: string;
  startupTime: string;
  version: string;
  userSettings: UserSettings;
  status: AppStatus;
  lastActivity: string;
}


export enum WorkspaceType {
  SingleProject = 'singleProject',
  MultiProject = 'multiProject',
  Documentation = 'documentation',
  Other = 'other',
}


export interface ProjectStatistics {
  totalFiles: number;
  totalLines: number;
  totalSize: number;
  filesByLanguage: Record<string, number>;
  filesByExtension: Record<string, number>;
  lastUpdated: string;
}


export interface WorkspaceInfo {
  id: string;
  name: string;
  rootPath: string;
  workspaceType: WorkspaceType;
  languages: string[];
  openedAt: string;
  lastAccessed: string;
  description?: string;
  tags: string[];
  statistics?: ProjectStatistics;
  metadata?: Record<string, any>;
}

export interface OpenWorkspaceOptions {
  addToRecent?: boolean;
  persist?: boolean;
  metadata?: Record<string, any>;
}


export enum WorkspaceAction {
  Opened = 'opened',
  Closed = 'closed',
  Switched = 'switched',
  Scanned = 'scanned',
  GraphBuilt = 'graphBuilt',
}


export interface WorkspaceHistoryEntry {
  workspaceId: string;
  action: WorkspaceAction;
  timestamp: string;
  description?: string;
}


export enum GraphStatus {
  Building = 'building',
  Ready = 'ready',
  Stale = 'stale',
  Error = 'error',
}


export enum CacheStrategy {
  LRU = 'lru',
  LFU = 'lfu',
  FIFO = 'fifo',
}


export interface CacheStatistics {
  totalCachedGraphs: number;
  cacheHitRate: number;
  totalMemoryUsage: number;
  oldestCacheAge?: string;
}

 
export interface GlobalStateAPI {
  
  initializeGlobalState(): Promise<string>;
  
  
  getAppState(): Promise<ApplicationState>;
  updateAppStatus(status: AppStatus): Promise<void>;

  
  openWorkspace(path: string, options?: OpenWorkspaceOptions): Promise<WorkspaceInfo>;
  closeWorkspace(): Promise<void>;
  getCurrentWorkspace(): Promise<WorkspaceInfo | null>;
  getRecentWorkspaces(): Promise<WorkspaceInfo[]>;
  scanWorkspaceInfo(workspacePath: string): Promise<WorkspaceInfo | null>;
  
  
  startFileWatch(path: string, recursive?: boolean): Promise<void>;
  stopFileWatch(path: string): Promise<void>;
  getWatchedPaths(): Promise<string[]>;
}

 
export function createGlobalStateAPI(): GlobalStateAPI {
  return {
    
    async initializeGlobalState(): Promise<string> {
      return await globalAPI.initializeGlobalState();
    },

    
    async getAppState(): Promise<ApplicationState> {
      return await globalAPI.getAppState();
    },

    async updateAppStatus(status: AppStatus): Promise<void> {
      return await globalAPI.updateAppStatus(status);
    },

    
    async openWorkspace(path: string, options?: OpenWorkspaceOptions): Promise<WorkspaceInfo> {
      logger.debug('openWorkspace called with', {
        path,
        pathType: typeof path,
        pathLength: path?.length,
        isEmpty: !path || path.trim() === ''
      });
      
      if (!path || path.trim() === '') {
        throw new Error('Path parameter is required and cannot be empty');
      }
      
      return await globalAPI.openWorkspace(path, options);
    },

    async closeWorkspace(): Promise<void> {
      return await globalAPI.closeWorkspace();
    },

    async getCurrentWorkspace(): Promise<WorkspaceInfo | null> {
      return await globalAPI.getCurrentWorkspace();
    },

    async getRecentWorkspaces(): Promise<WorkspaceInfo[]> {
      const workspaces = await globalAPI.getRecentWorkspaces();
      logger.debug('getRecentWorkspaces returned', workspaces);
      return workspaces;
    },

    async scanWorkspaceInfo(workspacePath: string): Promise<WorkspaceInfo | null> {
      return await globalAPI.scanWorkspaceInfo(workspacePath);
    },

    
    async startFileWatch(path: string, recursive?: boolean): Promise<void> {
      return await workspaceAPI.startFileWatch(path, recursive);
    },

    async stopFileWatch(path: string): Promise<void> {
      return await workspaceAPI.stopFileWatch(path);
    },

    async getWatchedPaths(): Promise<string[]> {
      return await workspaceAPI.getWatchedPaths();
    },
  };
}


export const globalStateAPI = createGlobalStateAPI();
