import {
  ApiOutlined,
  CloudUploadOutlined,
  DatabaseOutlined,
  MessageOutlined,
} from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { useIntl } from '@umijs/max';
import { Card, Space, Tag, Typography } from 'antd';
import React from 'react';

const { Text, Paragraph } = Typography;

// Placeholder landing page for the model platform. Phase 0 only ships
// the navigation surface; actual modules (registry / deploy / chat /
// routing) land in P7. Cards here advertise what's coming so the menu
// item isn't an empty room.
const ModelsLanding: React.FC = () => {
  const intl = useIntl();
  return (
    <PageContainer
      header={{
        title: intl.formatMessage({ id: 'pages.models.landing.title' }),
        subTitle: intl.formatMessage({ id: 'pages.models.landing.subtitle' }),
      }}
    >
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <FeatureCard
          icon={<DatabaseOutlined />}
          titleKey="pages.models.landing.registry.title"
          descKey="pages.models.landing.registry.desc"
        />
        <FeatureCard
          icon={<CloudUploadOutlined />}
          titleKey="pages.models.landing.deploy.title"
          descKey="pages.models.landing.deploy.desc"
        />
        <FeatureCard
          icon={<MessageOutlined />}
          titleKey="pages.models.landing.chat.title"
          descKey="pages.models.landing.chat.desc"
        />
        <FeatureCard
          icon={<ApiOutlined />}
          titleKey="pages.models.landing.routing.title"
          descKey="pages.models.landing.routing.desc"
        />
      </div>
    </PageContainer>
  );
};

const FeatureCard: React.FC<{
  icon: React.ReactNode;
  titleKey: string;
  descKey: string;
}> = ({ icon, titleKey, descKey }) => {
  const intl = useIntl();
  return (
    <Card>
      <Space direction="vertical" size={8} style={{ width: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Space size={8}>
            <span style={{ fontSize: 18, color: '#1677ff' }}>{icon}</span>
            <Text strong style={{ fontSize: 15 }}>
              {intl.formatMessage({ id: titleKey })}
            </Text>
          </Space>
          <Tag>
            {intl.formatMessage({ id: 'pages.models.landing.comingSoon' })}
          </Tag>
        </div>
        <Paragraph type="secondary" style={{ marginBottom: 0 }}>
          {intl.formatMessage({ id: descKey })}
        </Paragraph>
      </Space>
    </Card>
  );
};

export default ModelsLanding;
