import * as fs from 'fs';
import * as path from 'path';

export function readJsonl<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  const content = fs.readFileSync(filePath, 'utf-8').trim();
  if (!content) return [];
  const rows: T[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line) as T);
    } catch {
      // Corrupt rows are ignored so one bad diagnostic line cannot break memory.
    }
  }
  return rows;
}

export function appendJsonl(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(value) + '\n', 'utf-8');
}

export function writeJsonl<T>(filePath: string, values: T[]): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const content = values.map(value => JSON.stringify(value)).join('\n');
  fs.writeFileSync(filePath, content ? content + '\n' : '', 'utf-8');
}
