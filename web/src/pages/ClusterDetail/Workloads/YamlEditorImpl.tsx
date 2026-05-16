import { yaml } from '@codemirror/lang-yaml';
import { RangeSetBuilder } from '@codemirror/state';
import {
  Decoration,
  type DecorationSet,
  EditorView,
  ViewPlugin,
  type ViewUpdate,
} from '@codemirror/view';
import CodeMirror from '@uiw/react-codemirror';
import { useThemeMode } from 'antd-style';

// CodeMirror + the three @codemirror/* packages weigh ~500 KB gzip
// once decompressed. This file is the actual editor; it's loaded
// on-demand from `YamlEditor.tsx` (the public name), which wraps it
// in `React.lazy + Suspense` so Workloads / Compute / Plugins pages
// don't pay the cost just for landing on a route that *might* open
// an editor drawer.

// ─── K8s status-section decoration ────────────────────────────────────────────
// Lines under the top-level `status:` key are K8s-managed and cannot be
// changed via a normal Update call — dim them to signal read-only intent.

const statusLineDeco = Decoration.line({ class: 'cm-k8s-status' });

function buildStatusDecos(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  let inStatus = false;
  for (let i = 1; i <= view.state.doc.lines; i++) {
    const line = view.state.doc.line(i);
    if (/^status:/.test(line.text)) {
      inStatus = true;
      b.add(line.from, line.from, statusLineDeco);
    } else if (inStatus) {
      // Blank lines or indented lines are still part of the block.
      if (/^\s/.test(line.text) || line.text.trim() === '') {
        b.add(line.from, line.from, statusLineDeco);
      } else {
        inStatus = false;
      }
    }
  }
  return b.finish();
}

const k8sStatusPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildStatusDecos(view);
    }
    update(u: ViewUpdate) {
      if (u.docChanged) this.decorations = buildStatusDecos(u.view);
    }
  },
  { decorations: (v) => v.decorations },
);

const statusTheme = EditorView.baseTheme({
  // Dim the status block in both light and dark modes.
  '& .cm-k8s-status': { opacity: '0.45', fontStyle: 'italic' },
});

// ─── Component ────────────────────────────────────────────────────────────────

export interface YamlEditorProps {
  value: string;
  onChange?: (val: string) => void;
  readOnly?: boolean;
}

function YamlEditorImpl({ value, onChange, readOnly = false }: YamlEditorProps) {
  const { isDarkMode } = useThemeMode();

  return (
    <CodeMirror
      value={value}
      onChange={onChange}
      readOnly={readOnly}
      theme={isDarkMode ? 'dark' : 'light'}
      extensions={[yaml(), k8sStatusPlugin, statusTheme, EditorView.lineWrapping]}
      style={{ fontSize: 13 }}
      basicSetup={{
        lineNumbers: true,
        foldGutter: true,
        highlightActiveLine: !readOnly,
        highlightActiveLineGutter: !readOnly,
      }}
    />
  );
}

export default YamlEditorImpl;
