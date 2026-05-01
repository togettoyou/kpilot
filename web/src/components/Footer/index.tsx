import { DefaultFooter } from '@ant-design/pro-components';
import React from 'react';

const Footer: React.FC = () => (
  <DefaultFooter
    copyright={`${new Date().getFullYear()} KPilot`}
    style={{ background: 'none' }}
    links={[]}
  />
);

export default Footer;
