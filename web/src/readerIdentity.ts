export interface ReaderIdentity {
  userId: string;
  libraryId: string;
  path: string;
}
export function readerKey(kind: string, identity: ReaderIdentity) {
  return `codesip:${kind}:v2:${identity.userId}:${identity.libraryId}:${encodeURIComponent(identity.path)}`;
}
export function readerIdentities(
  kind: string,
  userId: string,
  libraryId?: string,
): ReaderIdentity[] {
  const prefix = `codesip:${kind}:v2:${userId}:`;
  return Object.keys(localStorage)
    .filter((key) => key.startsWith(prefix))
    .flatMap((key) => {
      const rest = key.slice(prefix.length),
        at = rest.indexOf(':');
      if (at < 1 || (libraryId && rest.slice(0, at) !== libraryId)) return [];
      try {
        return [
          { userId, libraryId: rest.slice(0, at), path: decodeURIComponent(rest.slice(at + 1)) },
        ];
      } catch {
        return [];
      }
    });
}
export const snapshotKey = (userId: string, libraryId: string) =>
  `codesip:reader-snapshot:v2:${userId}:${libraryId}`;
export function wasReaderLoaded(kind: string, identity: ReaderIdentity) {
  return !!(
    localStorage.getItem(readerKey(kind, identity)) ||
    localStorage.getItem(readerKey(kind + '-loaded', identity)) ||
    localStorage.getItem(snapshotKey(identity.userId, identity.libraryId))
  );
}
