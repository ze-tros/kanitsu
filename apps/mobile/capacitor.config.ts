import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.kanitu.viewer',
  appName: '全能看图王',
  webDir: '../web/dist',
  android: {
    allowMixedContent: false,
  },
};

export default config;
