// Impl-73 Step 4a — shared parser helpers.

// Strip a leading `---` … `---` YAML frontmatter block. Returns the body plus
// `offset` = number of lines removed, so callers can report parse flags against
// real (1-based) file line numbers. Tolerant: a block with no closing fence is
// left intact rather than swallowing content.
export function stripFrontmatter(text: string): {
  body: string;
  offset: number;
} {
  const lines = text.split('\n');
  if (lines[0]?.trim() !== '---') return { body: text, offset: 0 };
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      return { body: lines.slice(i + 1).join('\n'), offset: i + 1 };
    }
  }
  return { body: text, offset: 0 };
}
