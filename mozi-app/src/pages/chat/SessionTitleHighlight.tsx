export function SessionTitleHighlight({
  text,
  query,
}: {
  text: string;
  query: string;
}) {
  if (!query) return text;
  const lower = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();
  const parts = [];
  let start = 0;
  let index = lower.indexOf(needle);
  while (index !== -1) {
    parts.push(
      text.slice(start, index),
      <mark key={index}>{text.slice(index, index + query.length)}</mark>,
    );
    start = index + query.length;
    index = lower.indexOf(needle, start);
  }
  parts.push(text.slice(start));
  return parts;
}
