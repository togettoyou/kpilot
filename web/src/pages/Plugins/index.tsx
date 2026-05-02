import { PageContainer } from '@ant-design/pro-components';
import { useIntl } from '@umijs/max';
import { Empty } from 'antd';
import React from 'react';

export default function PluginsPage() {
  const intl = useIntl();
  return (
    <PageContainer title={intl.formatMessage({ id: 'pages.plugins.title' })}>
      <div className="flex items-center justify-center py-24">
        <Empty
          description={intl.formatMessage({ id: 'pages.plugins.comingSoon' })}
        />
      </div>
    </PageContainer>
  );
}
