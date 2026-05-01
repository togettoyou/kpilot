import Footer from './Footer';
import { LangDropdown } from './RightContent';
import { AvatarDropdown } from './RightContent/AvatarDropdown';

export { AvatarDropdown, Footer, LangDropdown };

// Re-exports for template demo pages (not used in routes, but avoids TS errors)
export { default as ArticleListContent } from './ArticleListContent';
export { default as AvatarList } from './AvatarList';
export { default as StandardFormRow } from './StandardFormRow';
export { default as TagSelect } from './TagSelect';
