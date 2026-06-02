import { Router } from 'express';
import { GauzMemService } from '../../gauzmem/service';

export function registerGauzMemRoutes(router: Router): void {
  router.get('/gauzmem/status', (_req, res) => {
    try {
      res.json(GauzMemService.getInstance().getStatus());
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get('/gauzmem/probe', async (_req, res) => {
    try {
      res.json(await GauzMemService.getInstance().probeReasoner());
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get('/gauzmem/runs', (req, res) => {
    try {
      const limit = Number(req.query.limit || 50);
      res.json({ runs: GauzMemService.getInstance().readRuns(limit) });
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get('/gauzmem/runs/:runId', (req, res) => {
    try {
      const run = GauzMemService.getInstance().readRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'run not found' });
      return res.json(run);
    } catch (e: any) {
      return res.status(500).json({ error: e?.message || String(e) });
    }
  });

  router.get('/gauzmem/graph', (_req, res) => {
    try {
      res.json(GauzMemService.getInstance().readGraph());
    } catch (e: any) {
      res.status(500).json({ error: e?.message || String(e) });
    }
  });
}
