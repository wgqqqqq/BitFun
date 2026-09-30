import { StatusBarViewExtensionAbility } from '@kit.DesktopExtensionKit';
import { Want, UIExtensionContentSession } from '@kit.AbilityKit';

export default class TrayAbility extends StatusBarViewExtensionAbility {
  onSessionCreate(_want: Want, session: UIExtensionContentSession): void {
    session.loadContent('pages/TrayPanel');
  }
}
