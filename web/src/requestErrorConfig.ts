import type { RequestConfig } from '@umijs/max';
import { message } from 'antd';

export const errorConfig: RequestConfig = {
  errorConfig: {
    errorHandler: (error: any, opts: any) => {
      if (opts?.skipErrorHandler) throw error;
      if (error.response) {
        const { status, data } = error.response;
        const msg = data?.error || data?.message || `HTTP ${status}`;
        message.error(msg);
      } else if (error.request) {
        message.error('Network error, please retry.');
      }
    },
  },
  requestInterceptors: [],
  responseInterceptors: [],
};
