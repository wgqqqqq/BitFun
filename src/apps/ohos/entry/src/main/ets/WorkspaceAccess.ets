/*
 * User-directory authorization for workspaces outside the application sandbox.
 *
 * HarmonyOS only reaches such a directory after the user picks it. The grant is
 * persisted against the directory URI and must be reactivated in every process,
 * so the URI - not the path - is what the product stores between runs.
 */
import picker from '@ohos.file.picker';
import fileShare from '@ohos.fileshare';
import fileUri from '@ohos.file.fileuri';
import fs from '@ohos.file.fs';
import common from '@ohos.app.ability.common';
import hilog from '@ohos.hilog';
import { BusinessError } from '@kit.BasicServicesKit';

const TAG: string = 'WorkspaceAccess';
const FOLDER_AUTHORIZATION: string = 'SystemCapability.FileManagement.AppFileService.FolderAuthorization';
const FOLDER_SELECTION: string = 'SystemCapability.FileManagement.UserFileService.FolderSelection';
/** Written by the product side; see src/apps/desktop/src/ohos/workspace_grants.rs. */
const REMEMBERED_GRANTS: string = 'harmony-workspace-grants.json';

interface AccessRequest {
  action: string;
  uris?: string[];
  write?: boolean;
}

interface RememberedGrants {
  uris?: string[];
}

interface AuthorizedDirectory {
  uri: string;
  path: string;
}

interface AccessResponse {
  ok: boolean;
  directories?: AuthorizedDirectory[];
  granted?: boolean[];
  folder_authorization?: boolean;
  folder_selection?: boolean;
  error?: string;
}

/**
 * Report the system's own failure text; a bare code is not diagnosable.
 * Policy failures carry their per-URI reason in `data`.
 */
function describe(error: BusinessError<Object>): string {
  let detail: string = `code=${error.code} message=${error.message}`;
  if (error.data !== undefined) {
    detail = `${detail} data=${JSON.stringify(error.data)}`;
  }
  return detail;
}

function failure(error: string): string {
  hilog.error(0x0000, TAG, error);
  const response: AccessResponse = { ok: false, error: error };
  return JSON.stringify(response);
}

export class WorkspaceAccess {
  private context: common.UIAbilityContext;

  constructor(context: common.UIAbilityContext) {
    this.context = context;
  }

  async perform(raw: string): Promise<string> {
    let request: AccessRequest;
    try {
      request = JSON.parse(raw) as AccessRequest;
    } catch (error) {
      return failure(`Malformed workspace access request: ${describe(error as BusinessError<Object>)}`);
    }
    const uris: string[] = request.uris ?? [];
    const mode: number = request.write === true
      ? fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE
      : fileShare.OperationMode.READ_MODE;
    try {
      switch (request.action) {
        case 'capability':
          return this.capability();
        case 'pick_folder':
          return await this.pickFolder(mode);
        case 'activate':
          return await this.activate(uris, mode);
        case 'check':
          return await this.check(uris, mode);
        default:
          return failure(`Unsupported workspace access action: ${request.action}`);
      }
    } catch (error) {
      return failure(`Workspace access '${request.action}' failed: ${describe(error as BusinessError<Object>)}`);
    }
  }

  private capability(): string {
    const response: AccessResponse = {
      ok: true,
      folder_authorization: canIUse(FOLDER_AUTHORIZATION),
      folder_selection: canIUse(FOLDER_SELECTION),
    };
    hilog.info(0x0000, TAG, `capability: ${JSON.stringify(response)}`);
    return JSON.stringify(response);
  }

  private policies(uris: string[], mode: number): fileShare.PolicyInfo[] {
    return uris.map((uri: string): fileShare.PolicyInfo => {
      const policy: fileShare.PolicyInfo = { uri: uri, operationMode: mode };
      return policy;
    });
  }

  private resolve(uris: string[]): AuthorizedDirectory[] {
    return uris.map((uri: string): AuthorizedDirectory => {
      const directory: AuthorizedDirectory = { uri: uri, path: new fileUri.FileUri(uri).path };
      return directory;
    });
  }

  /** Pick a folder, persist the grant, then activate it for this process. */
  private async pickFolder(mode: number): Promise<string> {
    if (!canIUse(FOLDER_SELECTION)) {
      return failure('This device does not support system folder selection');
    }
    if (!canIUse(FOLDER_AUTHORIZATION)) {
      return failure('This device does not support persistent folder authorization');
    }
    const options: picker.DocumentSelectOptions = new picker.DocumentSelectOptions();
    options.selectMode = picker.DocumentSelectMode.FOLDER;
    options.maxSelectNumber = 1;
    const selected: string[] = await new picker.DocumentViewPicker(this.context).select(options);
    // Cancelling is an ordinary outcome, not a failure; the caller reports no directory.
    if (selected.length === 0) {
      hilog.info(0x0000, TAG, 'pick_folder: cancelled');
      const cancelled: AccessResponse = { ok: true, directories: [] };
      return JSON.stringify(cancelled);
    }
    hilog.info(0x0000, TAG, `selected: ${JSON.stringify(selected)}`);
    const policies: fileShare.PolicyInfo[] = this.policies(selected, mode);
    // Without a persisted grant the directory is unreachable after a restart.
    try {
      await fileShare.persistPermission(policies);
    } catch (error) {
      return failure(`Could not persist the folder grant: ${describe(error as BusinessError<Object>)}`);
    }
    // The picker's own grant is temporary; activation is what this process uses.
    try {
      await fileShare.activatePermission(policies);
    } catch (error) {
      hilog.warn(0x0000, TAG, `activate after persist reported: ${describe(error as BusinessError<Object>)}`);
    }
    const response: AccessResponse = { ok: true, directories: this.resolve(selected) };
    hilog.info(0x0000, TAG, `pick_folder: ${JSON.stringify(response)}`);
    return JSON.stringify(response);
  }

  /** Reactivate persisted grants; a persisted grant is inert until activated. */
  private async activate(uris: string[], mode: number): Promise<string> {
    if (!canIUse(FOLDER_AUTHORIZATION)) {
      return failure('This device does not support persistent folder authorization');
    }
    const policies: fileShare.PolicyInfo[] = this.policies(uris, mode);
    const granted: boolean[] = await fileShare.checkPersistentPermission(policies);
    const live: string[] = uris.filter((_uri: string, index: number): boolean => granted[index] === true);
    if (live.length === 0) {
      return failure(`No persisted grant remains for the requested directories: ${JSON.stringify(uris)}`);
    }
    await fileShare.activatePermission(this.policies(live, mode));
    const response: AccessResponse = { ok: true, directories: this.resolve(live), granted: granted };
    hilog.info(0x0000, TAG, `activate: ${JSON.stringify(response)}`);
    return JSON.stringify(response);
  }

  /**
   * Reactivate every directory the user authorized in an earlier run.
   *
   * A persisted grant is inert until activated, and a child process inherits
   * only what this process already holds - so the agent's shell, git and
   * tooling reach an authorized workspace only if this runs before the product
   * runtime starts. Recorded grants are read, never written, here.
   */
  async activateRemembered(): Promise<void> {
    if (!canIUse(FOLDER_AUTHORIZATION)) {
      return;
    }
    const path: string = `${this.context.filesDir}/${REMEMBERED_GRANTS}`;
    let uris: string[] = [];
    try {
      if (!fs.accessSync(path)) {
        return;
      }
      uris = (JSON.parse(fs.readTextSync(path)) as RememberedGrants).uris ?? [];
    } catch (error) {
      hilog.error(0x0000, TAG, `Could not read remembered grants: ${describe(error as BusinessError<Object>)}`);
      return;
    }
    if (uris.length === 0) {
      return;
    }
    // Workspaces are edited, so reactivate with the same write mode they were granted with.
    const mode: number = fileShare.OperationMode.READ_MODE | fileShare.OperationMode.WRITE_MODE;
    try {
      hilog.info(0x0000, TAG, `activate_remembered: ${await this.activate(uris, mode)}`);
    } catch (error) {
      // A revoked or deleted directory must not stop the application from starting.
      hilog.error(0x0000, TAG,
        `Could not reactivate remembered grants: ${describe(error as BusinessError<Object>)}`);
    }
  }

  private async check(uris: string[], mode: number): Promise<string> {
    if (!canIUse(FOLDER_AUTHORIZATION)) {
      return failure('This device does not support persistent folder authorization');
    }
    const granted: boolean[] = await fileShare.checkPersistentPermission(this.policies(uris, mode));
    const response: AccessResponse = { ok: true, granted: granted };
    hilog.info(0x0000, TAG, `check: ${JSON.stringify(response)}`);
    return JSON.stringify(response);
  }
}
