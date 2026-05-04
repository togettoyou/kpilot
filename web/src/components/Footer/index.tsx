import React from 'react';

// Hand-rolled footer rather than antd-pro's DefaultFooter — its `copyright`
// prop is typed as string-only, so embedding a real <a> would need a cast.
const Footer: React.FC = () => (
  <div
    style={{
      padding: '16px 0 24px',
      textAlign: 'center',
      fontSize: 13,
      color: 'var(--ant-color-text-tertiary)',
    }}
  >
    {`© ${new Date().getFullYear()} KPilot · made by `}
    <a
      href="https://github.com/togettoyou"
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: 'inherit' }}
    >
      togettoyou
    </a>
  </div>
);

export default Footer;
