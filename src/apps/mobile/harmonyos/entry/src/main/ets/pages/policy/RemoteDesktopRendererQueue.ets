import { RemoteDesktopControlIntent } from '../../model/RemoteDesktopModels';

interface RendererControl {
  kind: string; renderer_id: string; attach_id: string; connection_id: string;
  control_epoch?: string;
  body?: RemoteDesktopControlIntent;
}

function pendingMove(raw: string): RendererControl | undefined {
  try {
    const command: RendererControl = JSON.parse(raw) as RendererControl;
    const input = command?.body, generation = input?.control_generation;
    const epoch = command?.control_epoch;
    const x = input?.body?.x, y = input?.body?.y;
    if (command?.kind !== 'control' || input?.kind !== 'pointer_move'
      || ![command.renderer_id, command.attach_id, command.connection_id].every((id: string): boolean => typeof id === 'string' && id.length > 0)
      || typeof generation !== 'string' || !/^[1-9][0-9]{0,19}$/.test(generation)
      || (generation.length === 20 && generation > '18446744073709551615')
      || (epoch !== undefined && (typeof epoch !== 'string' || !/^(0|[1-9][0-9]*)$/.test(epoch) || !Number.isSafeInteger(Number(epoch))))
      || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
      || x < 0 || x > 1 || y < 0 || y > 1) return undefined;
    return command;
  } catch (_error) { return undefined; }
}

/** Presentation bridge outbox. Never restamp, replay or silently drop input. */
export class RemoteDesktopRendererQueue {
  private commands: string[] = [];
  private bytes: number = 0;
  enqueue(command: string, discardPending: boolean = false): boolean {
    if (discardPending) this.clear();
    // Three bytes per UTF-16 unit is a conservative UTF-8 upper bound.
    const bytes = command.length * 3;
    const tail = this.commands[this.commands.length - 1];
    const previous = tail === undefined ? undefined : pendingMove(tail);
    const next = previous === undefined ? undefined : pendingMove(command);
    const replace = previous !== undefined && next !== undefined
      && previous.renderer_id === next.renderer_id && previous.attach_id === next.attach_id
      && previous.connection_id === next.connection_id
      && previous.control_epoch === next.control_epoch
      && previous.body?.control_generation === next.body?.control_generation;
    const total = this.bytes - (replace ? tail.length * 3 : 0) + bytes;
    if ((!replace && this.commands.length >= 128) || total > 384 * 1024) return false;
    if (replace) this.commands.pop();
    this.commands.push(command); this.bytes = total;
    return true;
  }
  take(): string | undefined {
    const command = this.commands.shift();
    if (command !== undefined) this.bytes -= command.length * 3;
    return command;
  }
  clear(): void { this.commands = []; this.bytes = 0; }
}
