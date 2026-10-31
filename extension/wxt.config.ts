import { defineConfig } from 'wxt';

export default defineConfig({
  manifest: {
    name: 'LoopHist',
    description: 'LoopHist - sinkron riwayat browsing lokal lintas browser',
    permissions: [
      'history',
      'storage',
      'alarms'
    ],
    host_permissions: [
      'ws://127.0.0.1:*/*',
      'http://127.0.0.1:*/*'
    ],
    icons: {
      16: 'icon-16.png',
      32: 'icon-32.png',
      48: 'icon-48.png',
      128: 'icon-128.png'
    },
    action: {
      default_icon: {
        16: 'icon-16.png',
        32: 'icon-32.png',
        48: 'icon-48.png',
        128: 'icon-128.png'
      }
    }
  }
});
