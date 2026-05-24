import { PageContainer } from '@ant-design/pro-components';
import { useIntl } from '@umijs/max';
import { Empty, Typography } from 'antd';
import { FileSearchOutlined } from '@ant-design/icons';

const { Paragraph } = Typography;

// SystemLogs is a placeholder for the future server + worker log
// query surface. The data path doesn't exist yet — the eventual
// design hooks into the same diag mux loopback bind on each
// process (so worker logs go through the existing yamux tunnel
// the same way snapshots do) and stores tail-able structured
// records, queryable by node + time + level.
//
// Kept as a separate page now so the sider menu has a stable slot
// for it once it ships; users browsing the area discover it exists
// and don't get a 404.
export default function SystemLogsPage() {
  const intl = useIntl();
  return (
    <PageContainer
      header={{
        title: intl.formatMessage({ id: 'pages.system.logs.title', defaultMessage: '系统日志' }),
        breadcrumb: {},
      }}
    >
      <Empty
        image={<FileSearchOutlined style={{ fontSize: 56, color: '#bfbfbf' }} />}
        imageStyle={{ height: 60 }}
        description={
          <div style={{ maxWidth: 460, margin: '0 auto', textAlign: 'left' }}>
            <Paragraph strong style={{ marginBottom: 4 }}>
              {intl.formatMessage({
                id: 'pages.system.logs.placeholder.title',
                defaultMessage: '系统日志页面 — 待落地',
              })}
            </Paragraph>
            <Paragraph type="secondary" style={{ marginBottom: 4 }}>
              {intl.formatMessage({
                id: 'pages.system.logs.placeholder.desc',
                defaultMessage:
                  '后续在这里查询 KPilot Server 与各 Worker 的运行日志,按节点 / 时间 / 等级过滤。',
              })}
            </Paragraph>
            <Paragraph type="secondary" style={{ marginBottom: 0 }}>
              {intl.formatMessage({
                id: 'pages.system.logs.placeholder.hint',
                defaultMessage:
                  '当前可以通过 `kubectl logs` 直连 Pod 或 docker logs 查看。',
              })}
            </Paragraph>
          </div>
        }
      />
    </PageContainer>
  );
}
