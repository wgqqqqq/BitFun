export { FileExplorer, FileTree, FileTreeNode } from './components';

export { useFileSystem } from './hooks';

export type {
  FileSystemNode,
  FileExplorerProps,
  FileExplorerToolbarHandlers,
  FileTreeProps,
  FileTreeNodeProps,
  FileSystemOptions,
  FileSystemState
} from './types';

export { getNewItemParentPath } from './utils/getNewItemParentPath';

export {
  getFileIcon,
  getFileIconClass,
  isImageFile,
  isCodeFile,
  isConfigFile
} from './utils/fileIcons';

export { fileSystemService } from './services/FileSystemService';
export { useExplorerController, useExplorerSnapshot } from '@/tools/file-explorer';
