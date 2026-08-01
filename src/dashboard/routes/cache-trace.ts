import type { Router } from 'express';
import { readCacheTraceStore, type CacheTraceStore } from '../../observability/cache-trace-reader';
import { resolveCacheTraceDir } from '../../observability/cache-trace';

export interface CacheTraceRouteOptions {
  traceDir?: string;
  cacheMs?: number;
}

export function registerCacheTraceRoutes(router: Router, options: CacheTraceRouteOptions = {}): void {
  let cached: CacheTraceStore | undefined;
  let cachedAt = 0;
  const load = async (): Promise<CacheTraceStore> => {
    const now = Date.now();
    if (cached && now - cachedAt < (options.cacheMs ?? 3000)) return cached;
    cached = await readCacheTraceStore(options.traceDir || resolveCacheTraceDir());
    cachedAt = now;
    return cached;
  };

  router.get('/cache-trace/status', async (_req, res) => {
    try {
      const store = await load();
      res.json({ ok: true, traceDir: store.traceDir, scannedFiles: store.scannedFiles, malformedFiles: store.malformedFiles, records: store.records.length, sessions: store.sessions.length });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.get('/cache-trace/sessions', async (_req, res) => {
    try {
      const store = await load();
      res.json({ ok: true, sessions: store.sessions });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });

  router.get('/cache-trace/session/:sessionId', async (req, res) => {
    try {
      const store = await load();
      const sessionId = String(req.params.sessionId || '');
      const records = store.records.filter(record => record.sessionId === sessionId);
      if (records.length === 0) return res.status(404).json({ ok: false, error: 'cache trace session not found' });
      res.json({ ok: true, session: store.sessions.find(item => item.sessionId === sessionId), records });
    } catch (error: any) {
      res.status(500).json({ ok: false, error: error?.message || String(error) });
    }
  });
}
