// NAPI lifecycle exports are consumed by the matching @ohos-rs/ability bridge.
export function configureResourceDirectory(directory: string): void;
export function registerWindowOperation(callback: (error: Error | null, action: string) => Promise<boolean>): void;
export function configureSystemDarkMode(dark: boolean): void;
export function configureDataDirectory(directory: string): void;
export function configureTerminalDiagnostics(enabled: boolean): void;
export function configureWorkspaceAccessDiagnostics(enabled: boolean): void;

export declare function registerExternalUrlOpener(callback: (error: Error | null, url: string) => Promise<boolean>): void;

export declare function registerTrayOperation(callback: (error: Error | null, action: string) => Promise<boolean>): void;

export function registerCompanionOperation(callback: (error: Error | null, request: string) => Promise<string>): void;

export function registerWorkspaceAccess(callback: (error: Error | null, request: string) => Promise<string>): void;
