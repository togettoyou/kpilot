import type { RequestConfig } from '@umijs/max';
import { getIntl, history } from '@umijs/max';
import { message } from 'antd';

const LOGIN_PATH = '/user/login';

function translateCode(code: string, status: number): string {
  const intl = getIntl();
  const translated = intl.formatMessage({ id: `errors.${code}`, defaultMessage: '' });
  return translated || code || `HTTP ${status}`;
}

export const errorConfig: RequestConfig = {
  errorConfig: {
    errorHandler: (error: any, opts: any) => {
      if (opts?.skipErrorHandler) throw error;
      if (error.response) {
        const { status, data } = error.response;
        // Session expired mid-use: kick the user back to /user/login
        // immediately instead of leaving them on a half-broken page
        // until they happen to navigate. The redirect= query lets
        // them come back to where they were after re-auth. Guard
        // against an infinite loop if /user/login itself 401s.
        if (status === 401) {
          const path = window.location.pathname + window.location.search;
          if (!path.startsWith(LOGIN_PATH)) {
            history.replace(`${LOGIN_PATH}?redirect=${encodeURIComponent(path)}`);
            return;
          }
        }
        // Some error codes are expected conditions a page handles
        // inline (e.g. cluster doesn't have a given CRD installed /
        // feature gate enabled). Re-throw without toasting so the
        // page-level onError can render a friendly placeholder.
        const SILENT_CODES = new Set(['RESOURCE_NOT_AVAILABLE']);
        if (data?.code && SILENT_CODES.has(data.code)) {
          throw error;
        }
        const msg = data?.message
          || (data?.code ? translateCode(data.code, status) : `HTTP ${status}`);
        message.error(msg);
      } else if (error.request) {
        const intl = getIntl();
        message.error(intl.formatMessage({ id: 'errors.NETWORK_ERROR', defaultMessage: 'Network error' }));
      }
    },
  },
  requestInterceptors: [],
  responseInterceptors: [],
};
