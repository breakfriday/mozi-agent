/** Conservative content-based sampling; equal lengths alone never establish readiness. */
export function isReadPlaceholder(content: string): boolean {
  return /^(?:loading(?:\.{0,3}|…)?|please wait(?:\.{0,3}|…)?|正在加载[\s.…。]*|加载中[\s.…。]*|请稍候[\s.…。]*)$/i.test(content.trim());
}

export function hasStableReadBody(previous: string, current: string): boolean {
  if (previous.length < 200 || current.length < 200) return false;
  // Ordered fixed-size chunks: no numerical masking, no attempt to invent a final state.
  const size = 80;
  const count = Math.max(Math.ceil(previous.length / size), Math.ceil(current.length / size));
  let same = 0;
  for (let i = 0; i < count; i++) {
    if (previous.slice(i * size, (i + 1) * size) === current.slice(i * size, (i + 1) * size)) same++;
  }
  return same / count >= 0.9;
}
