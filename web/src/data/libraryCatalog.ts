import type { Library } from '../../../shared/types';

// Availability belongs to this device's catalog, not the server's library schema.
export interface LibraryListing extends Library {
  localOnly?: true;
}

export function uniqueLibraries(libraries: readonly LibraryListing[]): LibraryListing[] {
  const byId = new Map<string, LibraryListing>();
  for (const library of libraries) {
    const previous = byId.get(library.id);
    if (!previous || library.revision >= previous.revision) byId.set(library.id, library);
  }
  return [...byId.values()];
}

export function cloudLibrary(library: LibraryListing): LibraryListing {
  const current = { ...library };
  delete current.localOnly;
  return current;
}

export function retainLocalArchives(remote: Library[], local: LibraryListing[]) {
  const ids = new Set(remote.map((library) => library.id));
  return uniqueLibraries([
    ...remote.map(cloudLibrary),
    ...local.filter((library) => library.localOnly && !ids.has(library.id)),
  ]);
}
