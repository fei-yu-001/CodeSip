import { invalidatePrivateData } from './session';
import { cacheAccess } from './localCache';
export async function clearPrivateData(keepAnnotations = false) {
  invalidatePrivateData();
  await cacheAccess('readwrite', (s) => s.clear());
  for (const key of Object.keys(localStorage))
    if (key.startsWith('codesip:')) {
      if (
        keepAnnotations &&
        (key.startsWith('codesip:annotations:') || key.startsWith('codesip:document:'))
      )
        continue;
      localStorage.removeItem(key);
    }
}
