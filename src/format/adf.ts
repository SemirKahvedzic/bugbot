/**
 * Minimal Atlassian Document Format builders.
 *
 * Jira's v3 REST API takes descriptions and comments as ADF, not wiki markup.
 * Rather than pull in a library, these are the handful of node types BugBot
 * actually emits, as small pure functions - which also makes the description
 * template trivial to unit test.
 */

export interface AdfNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

export interface AdfDoc {
  type: 'doc';
  version: 1;
  content: AdfNode[];
}

export function doc(...content: Array<AdfNode | undefined>): AdfDoc {
  return { type: 'doc', version: 1, content: content.filter((n): n is AdfNode => Boolean(n)) };
}

export function text(value: string): AdfNode {
  return { type: 'text', text: value };
}

export function bold(value: string): AdfNode {
  return { type: 'text', text: value, marks: [{ type: 'strong' }] };
}

export function code(value: string): AdfNode {
  return { type: 'text', text: value, marks: [{ type: 'code' }] };
}

export function link(label: string, href: string): AdfNode {
  return { type: 'text', text: label, marks: [{ type: 'link', attrs: { href } }] };
}

export function paragraph(...content: Array<AdfNode | undefined>): AdfNode {
  const children = content.filter((n): n is AdfNode => Boolean(n));
  // An empty paragraph must have no content key at all, or Jira rejects it.
  return children.length > 0
    ? { type: 'paragraph', content: children }
    : { type: 'paragraph' };
}

export function heading(level: 1 | 2 | 3 | 4 | 5 | 6, value: string): AdfNode {
  return { type: 'heading', attrs: { level }, content: [text(value)] };
}

export function rule(): AdfNode {
  return { type: 'rule' };
}

function listItem(...content: AdfNode[]): AdfNode {
  return { type: 'listItem', content };
}

export function bulletList(items: Array<AdfNode | AdfNode[]>): AdfNode {
  return {
    type: 'bulletList',
    content: items.map((item) => (Array.isArray(item) ? listItem(...item) : listItem(item))),
  };
}

export function orderedList(items: Array<AdfNode | AdfNode[]>): AdfNode {
  return {
    type: 'orderedList',
    attrs: { order: 1 },
    content: items.map((item) => (Array.isArray(item) ? listItem(...item) : listItem(item))),
  };
}

export type PanelType = 'info' | 'note' | 'warning' | 'success' | 'error';

export function panel(panelType: PanelType, ...content: AdfNode[]): AdfNode {
  return { type: 'panel', attrs: { panelType }, content };
}

/**
 * Multi-line free text -> one paragraph per non-empty line.
 * Jira renders a single paragraph with newlines as one run-on block, which is
 * exactly the unreadable result we are trying to get away from.
 */
export function paragraphs(value: string): AdfNode[] {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return lines.length > 0 ? lines.map((line) => paragraph(text(line))) : [paragraph(text('-'))];
}

/**
 * Free text -> an ordered list, stripping any numbering the reporter typed by
 * hand ("1.", "2)", "- ", "* ") so the rendered numbering is consistent whether
 * or not they bothered.
 */
export function numberedSteps(value: string): AdfNode {
  const lines = value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^\s*(?:\d+[.)]\s*|[-*•]\s*)/, '').trim())
    .filter((line) => line.length > 0);

  const items = lines.length > 0 ? lines : ['(no steps given)'];
  return orderedList(items.map((line) => paragraph(text(line))));
}
