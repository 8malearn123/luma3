import type { RichText } from './blocks';

type Nodes = NonNullable<RichText['ar']>;
type Inline = { text: string; bold?: boolean; italic?: boolean; href?: string };

/**
 * Plain-text editing format for the restricted rich-text structure used by
 * blocks. Paragraphs are separated by blank lines; "## " / "### " start
 * headings; lines starting with "- " form a bulleted list and "1. " a numbered
 * list. No markup is ever interpreted as HTML.
 */
export function richToPlain(nodes: Nodes | undefined): string {
  if (!nodes?.length) return '';
  const runs = (c: Inline[]) => c.map((r) => r.text).join('');
  return nodes.map((n) => {
    if (n.t === 'p') return runs(n.c);
    if (n.t === 'h2') return `## ${runs(n.c)}`;
    if (n.t === 'h3') return `### ${runs(n.c)}`;
    if (n.t === 'ul') return n.items.map((i) => `- ${runs(i)}`).join('\n');
    return n.items.map((i, k) => `${k + 1}. ${runs(i)}`).join('\n');
  }).join('\n\n');
}

export function plainToRich(text: string): Nodes {
  const out: Nodes = [];
  const blocks = text.replace(/\r\n/g, '\n').split(/\n{2,}/).map((b) => b.trim()).filter(Boolean).slice(0, 60);
  for (const b of blocks) {
    const lines = b.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.every((l) => /^[-*•]\s+/.test(l))) {
      out.push({ t: 'ul', items: lines.slice(0, 30).map((l) => [{ text: l.replace(/^[-*•]\s+/, '').slice(0, 2000) }]) });
    } else if (lines.every((l) => /^\d+[.)]\s+/.test(l))) {
      out.push({ t: 'ol', items: lines.slice(0, 30).map((l) => [{ text: l.replace(/^\d+[.)]\s+/, '').slice(0, 2000) }]) });
    } else if (lines.length === 1 && b.startsWith('### ')) {
      out.push({ t: 'h3', c: [{ text: b.slice(4).slice(0, 2000) }] });
    } else if (lines.length === 1 && b.startsWith('## ')) {
      out.push({ t: 'h2', c: [{ text: b.slice(3).slice(0, 2000) }] });
    } else {
      out.push({ t: 'p', c: [{ text: lines.join('\n').slice(0, 2000) }] });
    }
  }
  return out;
}

/** True when a rich-text value has no visible text in either language. */
export function richIsEmpty(v: RichText | undefined) {
  return !richToPlain(v?.ar).trim() && !richToPlain(v?.en).trim();
}
