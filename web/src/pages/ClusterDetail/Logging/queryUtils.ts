// LogsQL stream-selector keys emitted by Vector's kubernetes_logs source
// (the source the chart we ship turns on by default). Dots in field
// names are valid LogsQL — referenced as-is, no escaping.
export const FIELD_NS = 'kubernetes.pod_namespace';
export const FIELD_POD = 'kubernetes.pod_name';
export const FIELD_CONTAINER = 'kubernetes.container_name';

// composeStreamSelector turns the picker selections into a LogsQL
// stream selector like
//   {kubernetes.pod_namespace="default", kubernetes.pod_name="x"}.
// Empty inputs are skipped — picking only ns gives a ns-only selector.
// Empty across the board returns the empty string so the caller can
// decide whether to include the leading selector at all.
export function composeStreamSelector(
  ns: string,
  pod: string,
  container?: string,
): string {
  const parts: string[] = [];
  if (ns) parts.push(`${FIELD_NS}="${ns}"`);
  if (pod) parts.push(`${FIELD_POD}="${pod}"`);
  if (container) parts.push(`${FIELD_CONTAINER}="${container}"`);
  if (parts.length === 0) return '';
  return `{${parts.join(', ')}}`;
}

// mergeStreamSelector replaces the existing leading {...} selector
// in `existing` with `selector`, preserving everything the user typed
// after the selector. Previous behavior was a full overwrite which
// dropped any free-text terms or additional filters the user had
// added — surprising when paired with a picker. Now picking a
// namespace into an already-typed query keeps "error AND status:500"
// intact and just swaps the selector head.
//
// Behavior:
//   - existing has no selector: PREPEND the new selector.
//   - existing has a selector at the start: REPLACE it.
//   - new selector is empty: STRIP the existing selector.
//
// The selector-detection regex is anchored to start-of-string and
// accepts whitespace before/inside. LogsQL allows selectors anywhere
// in the query, but the picker-driven case always lives at the
// head (the picker IS the leading filter), so we keep the matcher
// simple and predictable.
export function mergeStreamSelector(
  existing: string,
  selector: string,
): string {
  const trimmed = existing.trimStart();
  // Match a leading {...} possibly containing escaped braces or
  // quoted values. Greedy up to the first `}` is fine because
  // LogsQL selectors don't nest.
  const match = trimmed.match(/^\{[^{}]*\}\s*/);
  const rest = match ? trimmed.slice(match[0].length) : trimmed;
  if (!selector) return rest;
  if (!rest) return selector;
  return `${selector} ${rest}`;
}

// extractSelectorParts inspects the leading selector of a query and
// returns the {ns, pod, container} it carries (any field absent = '').
// Lets the page re-derive picker state from a URL-restored or
// hand-typed query, so a returning user sees the pickers reflect
// what's already in the query bar.
export function extractSelectorParts(query: string): {
  ns: string;
  pod: string;
  container: string;
} {
  const trimmed = query.trimStart();
  const m = trimmed.match(/^\{([^{}]*)\}/);
  if (!m) return { ns: '', pod: '', container: '' };
  const body = m[1];
  // Split on commas not inside a quoted value. The selectors we
  // produce are always plain `field="value"` so a naive split is
  // safe; if the user hand-edited the query into something exotic
  // we just don't recover those parts (the picker shows blank,
  // user's free-form query is untouched).
  const parts = body.split(',').map((s) => s.trim());
  let ns = '';
  let pod = '';
  let container = '';
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const k = p.slice(0, eq).trim();
    let v = p.slice(eq + 1).trim();
    // Strip surrounding double quotes if present.
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (k === FIELD_NS) ns = v;
    else if (k === FIELD_POD) pod = v;
    else if (k === FIELD_CONTAINER) container = v;
  }
  return { ns, pod, container };
}

// extractHighlightTerms returns the text-search tokens that should
// be highlighted in rendered log messages. We strip the LogsQL
// scaffolding (selectors, field filters, operators) and keep just
// the bare word and quoted-phrase terms.
//
// This is a deliberately conservative extractor: false negatives
// (a term not highlighted) are fine; false positives (highlighting
// random operator words like "AND") would be visual noise. So we
// only count tokens that look like phrase/word search.
export function extractHighlightTerms(query: string): string[] {
  if (!query || query === '*') return [];
  // Strip leading stream selector entirely.
  const noSelector = query.replace(/^\s*\{[^{}]*\}\s*/, '');
  // Strip field:value patterns (kubernetes.pod_name:abc, level:!error,
  // status:>=500, foo:~"bar"). Field name is letters/digits/dots/
  // underscores; value chunk runs up to the next whitespace.
  const noField = noSelector.replace(/[\w.]+:[^\s]+/g, ' ');
  const terms: string[] = [];
  // Pull quoted phrases first.
  const phraseRe = /"([^"\\]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = phraseRe.exec(noField)) !== null) {
    if (m[1]) terms.push(m[1]);
  }
  const noPhrase = noField.replace(/"[^"]*"/g, ' ');
  // Whitespace-split residual tokens, drop operators / parens / empty.
  const RESERVED = new Set(['AND', 'OR', 'NOT', '|', '*']);
  for (const raw of noPhrase.split(/\s+/)) {
    const t = raw.replace(/[()|]/g, '').trim();
    if (!t) continue;
    if (RESERVED.has(t.toUpperCase())) continue;
    // Drop pure punctuation tokens left over from field stripping.
    if (!/[A-Za-z0-9]/.test(t)) continue;
    terms.push(t);
  }
  return terms;
}

// escapeRegex — for safely embedding a user-supplied term into the
// highlight RegExp. The terms come from query parsing, not direct
// user input, but LogsQL is permissive enough that `*` or `(` can
// reach us; without escaping they'd blow up `new RegExp`.
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
