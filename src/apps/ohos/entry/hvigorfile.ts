import { hapTasks } from '@ohos/hvigor-ohos-plugin';
import { hvigor } from '@ohos/hvigor';

// Validate even when PackageHap would otherwise reuse an incremental cache.
// IDE sync and explicit CompileArkTS remain available during the native port.
hvigor.taskGraphResolved(() => {
  const entries = hvigor.getCommandEntryTask() || [];
  if (entries.some(name => /assembleHap|assembleApp|PackageHap|PackageApp|SignHap|SignApp/.test(name))) {
    require('../tools/verify-runtime.cjs').verifyRuntime(__dirname);
  }
});
export default { system: hapTasks, plugins: [] };
