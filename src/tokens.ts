/** Parse a /context token value: "30.6k", "672", "~120", "< 20", "1m", "33k". */
export interface TokenValue {
  tokens: number;
  /** "<" = upper bound ("< 20"), "~" = estimate, "=" = as printed */
  qualifier: '<' | '~' | '=';
}

export function parseTokens(raw: string): TokenValue | null {
  const s = raw.trim().replace(/,/g, '');
  const m = s.match(/^(<|~)?\s*(\d+(?:\.\d+)?)\s*([kKmM])?$/);
  if (!m) return null;
  const n = parseFloat(m[2]);
  const mult = m[3] ? (m[3].toLowerCase() === 'k' ? 1_000 : 1_000_000) : 1;
  return { tokens: Math.round(n * mult), qualifier: (m[1] as '<' | '~' | undefined) ?? '=' };
}

/** Format tokens like /context does: 16700 -> "16.7K", 672 -> "672", 0 -> "0". */
export function fmtK(tokens: number): string {
  const sign = tokens < 0 ? '-' : '';
  const t = Math.abs(tokens);
  if (t < 1000) return `${sign}${Math.round(t)}`;
  if (t < 1_000_000) return `${sign}${(t / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return `${sign}${(t / 1_000_000).toFixed(2).replace(/0$/, '')}M`;
}

/** Always one decimal: 16700 -> "16.7K", 480 -> "0.5K". Used in aligned report columns. */
export function fmtK1(tokens: number): string {
  return `${(tokens / 1000).toFixed(1)}K`;
}
