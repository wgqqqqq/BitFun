import { RemoteDesktopInput, RemoteDesktopQueuedCommand } from '../../model/RemoteDesktopModels';
import { CloudAccountBinding, CloudAccountDevice } from '../../services/CloudAccountClient';
import { RemoteDesktopProjection, RemoteDesktopService } from '../../services/RemoteDesktopService';
import { RemoteDesktopKeyboardService } from '../../services/RemoteDesktopKeyboardService';
import { RemoteDesktopActions, RemoteDesktopState } from '../state/RemoteDesktopState';

export class RemoteDesktopViewModel {
  readonly state: RemoteDesktopState = new RemoteDesktopState();
  private readonly service: RemoteDesktopService;
  private controlRequested: boolean = false;
  private attemptedRenderer: string = '';
  readonly actions: RemoteDesktopActions;
  constructor(binding: () => CloudAccountBinding | undefined) {
    this.service = new RemoteDesktopService({ binding,
      update: (projection: RemoteDesktopProjection): void => {
        if (projection.stage === 'pausing' && this.state.stage !== 'pausing') this.state.rendererQueue.clear();
        this.state.stage = projection.stage; this.state.canReconnect = projection.canReconnect; this.state.deviceName = projection.deviceName;
        this.state.sourceLifecycleSupported = projection.sourceLifecycleSupported;
        this.state.qualitySupported = projection.qualitySupported; this.state.quality = projection.quality;
        this.state.signalingInterrupted = projection.signalingInterrupted;
        this.state.selectedDisplayId = projection.selectedDisplayId;
        this.state.displays = projection.displays; this.state.errorCode = projection.errorCode;
        this.state.forceRelay = projection.forceRelay; this.state.candidateType = projection.candidateType;
        this.state.controlReady = projection.controlReady; this.state.controlSupported = projection.controlSupported; this.state.textSupported = projection.textSupported;
        this.state.controlState = projection.controlState; this.state.controlGeneration = projection.controlGeneration; this.state.rendererId = projection.rendererId;
        this.state.controlError = projection.controlError;
        this.state.videoWidth = projection.videoWidth; this.state.videoHeight = projection.videoHeight;
        if (projection.stage === 'observing' && (projection.signalingInterrupted || projection.controlError.length > 0)) {
          this.controlRequested = false;
        }
        this.acquireDefaultControl();
      },
      renderer: (command: string): void => {
        const value: RemoteDesktopQueuedCommand = JSON.parse(command) as RemoteDesktopQueuedCommand;
        const discard = value.kind === 'stop' || (value.kind === 'control' && value.body?.kind === 'release_control');
        if (!this.state.queueRenderer(command, discard)) this.service.rendererFailed();
      }
    });
    this.actions = {
      reconnect: (): void => { this.requestDefaultControl(); void this.service.reconnect(); },
      pauseSource: (): void => { this.controlRequested = false; void this.service.pauseSource(); },
      resumeSource: (): void => { this.requestDefaultControl(); this.state.panMode = false; void this.service.resumeSource(); },
      chooseSource: (): void => { void this.service.chooseSource(); },
      cancelSourceChoice: (): void => this.service.cancelSourceChoice(),
      selectSource: (displayId: string): void => { this.requestDefaultControl(); this.state.panMode = false; void this.service.selectSource(displayId); },
      setQuality: (quality: string): void => { void this.service.setQuality(quality); },
      close: (): void => { this.controlRequested = false; this.service.close(); this.state.visible = false; },
      attach: (displayId: string, forceRelay: boolean): void => { this.requestDefaultControl(); void this.service.attach(displayId, forceRelay); },
      receive: (raw: string): void => { void this.service.receive(raw); },
      acquireControl: (): void => { this.controlRequested = true; this.attemptedRenderer = this.state.rendererId; this.state.panMode = false; void this.service.acquireControl(); },
      releaseControl: (reason?: 'input_suspended'): void => { this.controlRequested = false; this.service.releaseControl(reason); },
      input: (message: RemoteDesktopInput): void => {
        RemoteDesktopKeyboardService.beforePointer(message); this.service.input(message);
      },
      toggleDirectTouch: (): void => { this.actions.releaseControl(); this.state.directTouch = !this.state.directTouch; },
      togglePan: (): void => { this.state.panMode = !this.state.panMode; }
    };
  }
  private requestDefaultControl(): void { this.controlRequested = true; this.attemptedRenderer = ''; }
  private acquireDefaultControl(): void {
    const renderer = this.state.rendererId;
    if (!this.controlRequested || !this.state.visible || this.state.stage !== 'observing' || !this.state.controlSupported
      || !this.state.controlReady || this.state.signalingInterrupted || !this.state.candidateType || !renderer || renderer === this.attemptedRenderer
      || this.state.controlState !== 'viewing' || this.state.controlError.length > 0 || this.state.panMode) return;
    // One attempt after presentation and a current transport report. Never
    // retry a refusal or turn an explicit stop/revocation into reacquisition.
    this.attemptedRenderer = renderer;
    void Promise.resolve().then((): void => {
      if (this.controlRequested && this.state.visible && this.state.stage === 'observing'
        && this.state.rendererId === renderer && this.state.controlReady && !this.state.signalingInterrupted && !this.state.panMode
        && this.state.controlState === 'viewing' && this.state.controlError.length === 0) void this.service.acquireControl();
    });
  }
  open(device: CloudAccountDevice): void { this.requestDefaultControl(); this.state.panMode = false; this.state.visible = true; void this.service.open(device); }
  close(): void { this.actions.close(); }
}
