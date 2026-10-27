import { RemoteDesktopRendererQueue } from '../policy/RemoteDesktopRendererQueue';
import { RemoteDesktopDisplay, RemoteDesktopInput } from '../../model/RemoteDesktopModels';
export interface RemoteDesktopActions {
  close: () => void;
  reconnect: () => void;
  pauseSource: () => void;
  resumeSource: () => void;
  chooseSource: () => void;
  cancelSourceChoice: () => void;
  selectSource: (displayId: string) => void;
  setQuality: (quality: string) => void;
  attach: (displayId: string, forceRelay: boolean) => void;
  receive: (raw: string) => void;
  acquireControl: () => void;
  releaseControl: (reason?: 'input_suspended') => void;
  input: (message: RemoteDesktopInput) => void;
  toggleDirectTouch: () => void;
  togglePan: () => void;
}
export function emptyRemoteDesktopActions(): RemoteDesktopActions {
  return { close: (): void => {}, reconnect: (): void => {}, pauseSource: (): void => {}, resumeSource: (): void => {},
    chooseSource: (): void => {}, cancelSourceChoice: (): void => {}, selectSource: (_displayId: string): void => {},
    setQuality: (_quality: string): void => {},
    attach: (_displayId: string, _forceRelay: boolean): void => {}, receive: (_raw: string): void => {},
    acquireControl: (): void => {}, releaseControl: (): void => {}, input: (_message: RemoteDesktopInput): void => {},
    toggleDirectTouch: (): void => {}, togglePan: (): void => {} };
}
@ObservedV2
export class RemoteDesktopState {
  @Trace visible: boolean = false;
  @Trace stage: string = 'idle';
  @Trace canReconnect: boolean = false;
  @Trace sourceLifecycleSupported: boolean = false;
  @Trace qualitySupported: boolean = false;
  @Trace quality: string = 'data_saver';
  @Trace signalingInterrupted: boolean = false;
  @Trace selectedDisplayId: string = '';
  @Trace deviceName: string = '';
  @Trace displays: RemoteDesktopDisplay[] = [];
  @Trace errorCode: string = '';
  @Trace forceRelay: boolean = false;
  @Trace candidateType: string = '';
  @Trace controlSupported: boolean = false;
  @Trace textSupported: boolean = false;
  @Trace controlReady: boolean = false;
  @Trace controlState: string = 'viewing';
  @Trace controlGeneration: string = '';
  @Trace rendererId: string = '';
  @Trace controlError: string = '';
  @Trace videoWidth: number = 0;
  @Trace videoHeight: number = 0;
  @Trace directTouch: boolean = true;
  @Trace panMode: boolean = false;
  readonly rendererQueue: RemoteDesktopRendererQueue = new RemoteDesktopRendererQueue();
  queueRenderer(command: string, discardPending: boolean = false): boolean {
    if (!this.rendererQueue.enqueue(command, discardPending)) return false;
    this.rendererVersion++; return true;
  }
  @Trace rendererVersion: number = 0;
}
