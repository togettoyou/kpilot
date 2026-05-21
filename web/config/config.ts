import { join } from 'node:path';
import { defineConfig } from '@umijs/max';
import proxy from './proxy';
import routes from './routes';

const { UMI_ENV = 'dev' } = process.env;

export default defineConfig({
  hash: true,
  publicPath: '/',
  routes,
  // Switch off esbuild for production minification, use terser. Two
  // unrelated wins from the same lever:
  //   1. esbuild's per-chunk helper naming collides across the many
  //      code-split chunks (10 Volcano CR pages + lazy YamlEditor /
  //      PodExecDrawer / GPUMonitoring chart) and utoopack rejects
  //      the build outright. Previous workaround was
  //      esbuildMinifyIIFE: true, but —
  //   2. — wrapping each chunk in its own IIFE breaks the ESM live
  //      bindings xterm relies on for its class inheritance across
  //      chunks. `class la extends X` where X resolves to null at
  //      class-construction time crashes the exec drawer with
  //      "Super constructor null of la is not a constructor"
  //      (xterm.js renderer createInstance path).
  // Terser preserves class inheritance correctly, doesn't have the
  // helper-name collision, and is the standard prod minifier in the
  // React ecosystem. Build is a bit slower than esbuild but not
  // by an interesting amount.
  jsMinifier: 'terser',
  ignoreMomentLocale: true,
  proxy: proxy[UMI_ENV as keyof typeof proxy],
  fastRefresh: true,
  model: {},
  initialState: {},
  title: 'KPilot',
  favicons: ['/favicon.svg'],
  layout: {
    locale: true,
    title: 'KPilot',
    logo: '/logo.svg',
    navTheme: 'light',
    layout: 'mix',
    fixSiderbar: true,
  },
  moment2dayjs: {
    preset: 'antd',
    plugins: ['duration', 'relativeTime'],
  },
  locale: {
    default: 'zh-CN',
    antd: true,
    baseNavigator: true,
  },
  antd: {
    appConfig: {},
    configProvider: {
      variant: 'filled',
      theme: {
        token: {
          fontFamily: 'AlibabaSans, sans-serif',
        },
      },
    },
  },
  request: {},
  access: {},
  headScripts: [{ src: join('/', 'scripts/loading.js'), async: true }],
  mock: {
    include: ['src/pages/**/_mock.ts'],
  },
  exportStatic: {},
});
