/**
 * Native v1.26.4 source-stamp splice, copied as a read-only adapter from
 * `src/wiki/page-factory/create-page.ts` (appendSourceSlugToFrontmatter).
 *
 * Keeping this tiny pure helper local prevents the headless CLI from importing
 * PageFactory's Obsidian runtime graph.  The focused compatibility tests keep
 * the byte shape anchored to the native helper.
 */
export function appendNativeSourceSlugToFrontmatter(content: string, sourceSlug: string): string {
  if (!content.startsWith('---')) return content;
  const fmEnd = content.indexOf('\n---\n', 3);
  if (fmEnd === -1) return content;
  const fmText = content.substring(3, fmEnd).replace(/^\n/u, '');
  const body = content.substring(fmEnd + 5);
  const sourceEntry = `[[sources/${sourceSlug}]]`;
  const lines = fmText.split('\n');

  const flowIdx = lines.findIndex(line => /^sources:\s*\[.*\]\s*$/u.test(line));
  if (flowIdx !== -1) {
    const flowMatch = lines[flowIdx]?.match(/^sources:\s*\[(.*)\]\s*$/u);
    const entries: string[] = [];
    if (flowMatch && flowMatch[1].trim().length > 0) {
      const linkPattern = /\[\[([^\]]+)\]\]/gu;
      let match: RegExpExecArray | null;
      while ((match = linkPattern.exec(flowMatch[1])) !== null) entries.push(match[1]);
    }
    const targetLink = sourceEntry.slice(2, -2);
    if (entries.includes(targetLink)) return content;
    entries.push(targetLink);
    const blockLines = ['sources:', ...entries.map(entry => `  - "[[${entry}]]"`)];
    lines.splice(flowIdx, 1, ...blockLines);
    return `---\n${lines.join('\n')}\n---\n${body}`;
  }

  const sourcesIdx = lines.findIndex(line => /^sources:\s*$/u.test(line));
  if (sourcesIdx === -1) {
    const tagsIdx = lines.findIndex(line => /^tags:\s*$/u.test(line));
    const insertAt = tagsIdx === -1 ? lines.length : tagsIdx;
    lines.splice(insertAt, 0, `sources:\n  - "${sourceEntry}"`);
  } else {
    const entries: string[] = [];
    const seen = new Set<string>();
    let contEnd = sourcesIdx + 1;
    for (let index = sourcesIdx + 1; index < lines.length; index++) {
      const line = lines[index]?.trim() ?? '';
      if (!line.startsWith('- ')) break;
      contEnd = index + 1;
      let entry = line.substring(2).trim();
      if ((entry.startsWith('"') && entry.endsWith('"')) || (entry.startsWith("'") && entry.endsWith("'"))) {
        entry = entry.slice(1, -1);
      }
      if (entry.startsWith('[[') && entry.endsWith(']]')) {
        const inner = entry.slice(2, -2).trim();
        if (!seen.has(inner)) {
          seen.add(inner);
          entries.push(inner);
        }
      }
    }
    const targetInner = sourceEntry.slice(2, -2);
    if (seen.has(targetInner)) return content;
    entries.push(targetInner);
    const newContinuation = entries.map(entry => `  - "[[${entry}]]"`);
    lines.splice(sourcesIdx + 1, contEnd - (sourcesIdx + 1), ...newContinuation);
  }
  return `---\n${lines.join('\n')}\n---\n${body}`;
}

