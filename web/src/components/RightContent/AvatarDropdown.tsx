import { LogoutOutlined } from '@ant-design/icons';
import { history, useIntl, useModel } from '@umijs/max';
import type { MenuProps } from 'antd';
import { Spin } from 'antd';
import React from 'react';
import { flushSync } from 'react-dom';
import { logout } from '@/services/kpilot/auth';
import HeaderDropdown from '../HeaderDropdown';

export type GlobalHeaderRightProps = {
  children?: React.ReactNode;
};

export const AvatarDropdown: React.FC<GlobalHeaderRightProps> = ({ children }) => {
  const intl = useIntl();
  const { initialState, setInitialState } = useModel('@@initialState');

  const onMenuClick: MenuProps['onClick'] = async ({ key }) => {
    if (key === 'logout') {
      flushSync(() => {
        setInitialState((s) => ({ ...s, currentUser: undefined }));
      });
      await logout();
      history.replace('/user/login');
    }
  };

  if (!initialState?.currentUser) {
    return <Spin size="small" />;
  }

  const menuItems: MenuProps['items'] = [
    {
      key: 'logout',
      icon: <LogoutOutlined />,
      label: intl.formatMessage({ id: 'menu.account.logout' }),
    },
  ];

  return (
    <HeaderDropdown
      placement="bottomRight"
      menu={{ selectedKeys: [], onClick: onMenuClick, items: menuItems }}
      arrow
    >
      {children}
    </HeaderDropdown>
  );
};
