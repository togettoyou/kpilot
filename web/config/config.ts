import { join } from 'node:path';
import { defineConfig } from '@umijs/max';
import proxy from './proxy';
import routes from './routes';

const { UMI_ENV = 'dev' } = process.env;

export default defineConfig({
  hash: true,
  publicPath: '/',
  routes,
  // esbuild's default minifier picks per-chunk helper names that
  // collide across the many code-split chunks (10 Volcano CR pages
  // + lazy-loaded YamlEditor / PodExecDrawer / GPUMonitoring chart).
  // Wrapping each chunk in its own IIFE scopes the helpers so they
  // can't conflict; utoopack surfaces a fatal error otherwise.
  esbuildMinifyIIFE: true,
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
  headScripts: [
    { src: join('/', 'scripts/loading.js'), async: true },
  ],
  mock: {
    include: ['src/pages/**/_mock.ts'],
  },
  exportStatic: {},
});
