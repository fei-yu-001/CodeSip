// Compatibility entry point for existing consumers. New code imports its
// specific boundary so local reading does not depend on synchronization.
export { api, HttpError } from './data/http';
export { cached, save, remove } from './data/localCache';
export { cacheGeneration, onPrivateDataCleared } from './data/session';
export { clearPrivateData } from './data/privateData';
export {
  manifestKey,
  fileBlob,
  downloadLibrary,
  cacheFileRemoval,
  removeLibraryCache,
  cachedLibraries,
} from './data/libraryRepository';
export { formatBytes, relativeDate } from './format';
