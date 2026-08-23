import { useMemo } from 'react';
import {
  ElectronImportSourcePicker,
  ElectronLibraryStore,
  MemoryImportSourcePicker,
  MemoryLibraryStore,
} from '../../../packages/fs-adapter/src/index';
import { LibraryBrowser } from '../../../packages/ui/src/index';

export default function App() {
  const adapters = useMemo(() => {
    if (window.kanituDesktop?.platform === 'electron') {
      return {
        picker: new ElectronImportSourcePicker(),
        store: new ElectronLibraryStore(),
        mode: 'Electron v0.4',
      };
    }
    return {
      picker: MemoryImportSourcePicker.fromDemo(),
      store: new MemoryLibraryStore(),
      mode: 'Web demo v0.4',
    };
  }, []);

  return (
    <>
      <div className="mode-badge">{adapters.mode}</div>
      <LibraryBrowser picker={adapters.picker} store={adapters.store} />
    </>
  );
}