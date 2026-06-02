import * as fs from 'fs';
import * as path from 'path';

export function getGauzMemRoot(): string {
  return path.resolve(process.cwd(), 'data', 'gauzmem');
}

export function getGauzMemSourceDir(): string {
  return path.join(getGauzMemRoot(), 'sources');
}

export function getGauzMemStoreDir(): string {
  return path.join(getGauzMemRoot(), 'store');
}

export function ensureGauzMemDirs(): void {
  fs.mkdirSync(getGauzMemSourceDir(), { recursive: true });
  fs.mkdirSync(getGauzMemStoreDir(), { recursive: true });
}

export const GauzMemFiles = {
  sources: () => path.join(getGauzMemSourceDir(), 'session_messages.jsonl'),
  sourceWindows: () => path.join(getGauzMemSourceDir(), 'source_windows.jsonl'),
  nodes: () => path.join(getGauzMemStoreDir(), 'nodes.jsonl'),
  edges: () => path.join(getGauzMemStoreDir(), 'edges.jsonl'),
  nodeState: () => path.join(getGauzMemStoreDir(), 'node_state.jsonl'),
  edgeState: () => path.join(getGauzMemStoreDir(), 'edge_state.jsonl'),
  runs: () => path.join(getGauzMemStoreDir(), 'runs.jsonl'),
  events: () => path.join(getGauzMemStoreDir(), 'events.jsonl'),
};
