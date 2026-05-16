import { theme as antdTheme } from 'antd';
import React, { lazy, Suspense } from 'react';

import type { YamlEditorProps } from './YamlEditorImpl';

// Lazy wrapper around the real CodeMirror-based editor in
// `YamlEditorImpl.tsx`. The named-export name `YamlEditor` is kept so
// every existing importer (14 across Workloads / Nodes / Plugins /
// Volcano forms / Scheduler / shared YamlCreateDrawer) keeps working
// transparently — they get code-splitting for free.
//
// Before: every page that imported YamlEditor pulled in @codemirror/*
// + @uiw/react-codemirror (~500 KB gzip) at route-entry time, even if
// the user never opened a YAML drawer. After: the chunk only ships
// when an editor actually mounts. Visible win on the Workloads main
// page (the most-visited route in the app) and on every Volcano CR
// list page that has a Form drawer.
const YamlEditorImpl = lazy(() => import('./YamlEditorImpl'));

export function YamlEditor(props: YamlEditorProps) {
  return (
    <Suspense fallback={<EditorFallback readOnly={props.readOnly} />}>
      <YamlEditorImpl {...props} />
    </Suspense>
  );
}

// Skeleton sized roughly like a small editor so the drawer doesn't
// jump when the chunk arrives. Color tracks the antd theme so dark
// mode users don't get a flash of white.
function EditorFallback({ readOnly: _ }: { readOnly?: boolean }) {
  const { token } = antdTheme.useToken();
  return (
    <div
      style={{
        minHeight: 220,
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorderSecondary}`,
        borderRadius: token.borderRadius,
      }}
    />
  );
}

export type { YamlEditorProps };
