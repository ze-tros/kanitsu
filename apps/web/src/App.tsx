import { useMemo, useState } from 'react';
import {
  ElectronImportSourcePicker,
  ElectronLibraryStore,
  MemoryImportSourcePicker,
  MemoryLibraryStore,
} from '../../../packages/fs-adapter/src/index';
import {
  createIdbPersistentIndex,
  createMemoryPersistentIndex,
} from '../../../packages/core/src/index';
import { LibraryBrowser } from '../../../packages/ui/src/index';

export default function App() {
  const adapters = useMemo(() => {
    if (window.kanituDesktop?.platform === 'electron') {
      return {
        picker: new ElectronImportSourcePicker(),
        store: new ElectronLibraryStore(),
      };
    }
    return {
      picker: MemoryImportSourcePicker.fromDemo(),
      store: new MemoryLibraryStore(),
    };
  }, []);

  // Only persist the scan index for the Electron (persistent) library. The web/memory
  // demo store is ephemeral, so it always rescans fresh and caches in memory only.
  const [index] = useState(() =>
    window.kanituDesktop?.platform === 'electron'
      ? createIdbPersistentIndex()
      : createMemoryPersistentIndex(),
  );

  return <LibraryBrowser picker={adapters.picker} store={adapters.store} index={index} />;
}
