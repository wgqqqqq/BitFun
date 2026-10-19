import { AbilityStage, Want } from '@kit.AbilityKit';
import { MiniAppShortcuts } from './MiniAppShortcuts';
export default class MiniAppStage extends AbilityStage {
  onAcceptWant(want: Want): string {
    if (want.abilityName !== 'MiniAppAbility') return '';
    const id = want.parameters?.['openbitfun.miniappLaunchId'];
    if (typeof id !== 'string') return '';
    return MiniAppShortcuts.id(id);
  }
}
