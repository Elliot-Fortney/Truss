import type { Files } from '../../src/core/ports.ts';

/** The Files port over a Map, for tests. `texts` holds the non-source files (the Sidecar) by name. */
export interface MemoryFiles extends Files {
  texts: Map<string, string>;
  /** Names passed to `writeText`, in order. */
  writes: string[];
}

export function memoryFiles(sources = new Map<string, string>(), texts: Record<string, string> = {}): MemoryFiles {
  const store = new Map(Object.entries(texts));
  const writes: string[] = [];
  return {
    texts: store,
    writes,
    read: async () => sources,
    readText: async (name) => store.get(name),
    writeText: async (name, text) => {
      writes.push(name);
      store.set(name, text);
    },
    watch: () => () => undefined,
  };
}
