import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kanitsu.viewer',
  appName: 'Kanitsu',
  webDir: '../web/dist',
  android: {
    allowMixedContent: false,
  },
};

export default config;
