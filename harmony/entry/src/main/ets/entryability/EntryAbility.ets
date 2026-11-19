import { UIAbility } from '@kit.AbilityKit';
import { window } from '@kit.ArkUI';
import { hilog } from '@kit.PerformanceAnalysisKit';
export default class EntryAbility extends UIAbility {
  onWindowStageCreate(windowStage: window.WindowStage): void {
    try {
      windowStage.loadContent('pages/Index', (error) => {
        if (error.code) { hilog.error(0x0000, 'CodeSip', 'Page load failed: %{public}d', error.code); }
      });
    } catch (_) {
      hilog.error(0x0000, 'CodeSip', 'Unable to load the reader page');
    }
  }
}
