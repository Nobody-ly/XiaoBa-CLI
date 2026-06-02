import { createHash } from 'crypto';

export function stableHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}

export function normalizeMemoryText(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncateText(text: string, max = 1200): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + '...';
}
