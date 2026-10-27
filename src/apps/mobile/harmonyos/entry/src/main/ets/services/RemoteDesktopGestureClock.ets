import { systemDateTime } from '@kit.BasicServicesKit';

/** Native event time and live uptime stay separate; neither uses calendar time. */
export class RemoteDesktopGestureClock {
  /** ArkUI BaseEvent timestamp is boot-relative nanoseconds, before dispatch. */
  static fromEvent(timestamp: number): number | undefined {
    return Number.isFinite(timestamp) && timestamp >= 0 ? timestamp / 1000000 : undefined;
  }
  static now(): number | undefined {
    try {
      const now = systemDateTime.getUptime(systemDateTime.TimeType.STARTUP, false);
      return Number.isFinite(now) && now >= 0 ? now : undefined;
    } catch (_error) { return undefined; }
  }
}
