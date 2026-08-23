import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kanitu.viewer',
  appName: 'Kanitu Viewer',
  webDir: '../web/dist',
  bundledWebRuntime: false,
  android: {
    allowMixedContent: false,
  },
};

export default config;
