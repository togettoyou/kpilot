import { join } from 'node:path';
import { defineConfig } from '@umijs/max';
import proxy from './proxy';
import routes from './routes';

const { UMI_ENV = 'dev' } = process.env;

export default defineConfig({
  hash: true,
  publicPath: '/',
  routes,
  ignoreMomentLocale: true,
  proxy: proxy[UMI_ENV as keyof typeof proxy],
  fastRefresh: true,
  model: {},
  initialState: {},
  title: 'KPilot',
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
