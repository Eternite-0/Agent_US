export function registerRuntimeRoutes(app, { store, directAgent, controlPlane }) {
  const audit = controlPlane?.auditService;

  app.get('/v1/runtime/overview', async () => {
    if (controlPlane) return controlPlane.getOverview();
    return {
      ok: true,
      activeTurns: directAgent?.activeTurns?.size ?? 0,
      pendingApprovals: 0,
      pendingReconciliations: 0,
      unknownReceipts: 0,
      activeSwarmRuns: 0,
      enabledSchedules: 0,
    };
  });

  app.get('/v1/sessions/:id/receipts', async (req) => {
    const q = req.query ?? {};
    if (audit) {
      return {
        items: audit.listReceipts({
          sessionId: req.params.id,
          turnId: q.turnId ? String(q.turnId) : null,
          status: q.status ? String(q.status) : null,
          limit: Number(q.limit ?? 200),
        }),
      };
    }
    return {
      items: store.db
        .prepare('SELECT * FROM tool_receipts WHERE sessionId=? ORDER BY createdAt DESC LIMIT 200')
        .all(req.params.id),
    };
  });

  app.get('/v1/sessions/:id/checkpoints', async (req) => {
    const q = req.query ?? {};
    if (audit) {
      return {
        items: audit.listCheckpoints({
          sessionId: req.params.id,
          turnId: q.turnId ? String(q.turnId) : null,
          limit: Number(q.limit ?? 100),
        }),
      };
    }
    return {
      items: store.db
        .prepare('SELECT * FROM runtime_checkpoints WHERE sessionId=? ORDER BY createdAt DESC LIMIT 100')
        .all(req.params.id),
    };
  });

  app.get('/v1/sessions/:id/compactions', async (req) => ({
    items: directAgent?.compactor?.listCompactions(req.params.id) ?? [],
  }));

  app.get('/v1/sessions/:id/children', async (req) => ({
    items: directAgent?.sessionRepo?.listChildSessions(req.params.id) ?? [],
  }));

  app.get('/v1/sessions/:id/notifications', async (req) => ({
    items:
      directAgent?.childManager?.collectNotifications?.(req.params.id, {
        unreadOnly: req.query?.unreadOnly === 'true',
      }) ?? [],
  }));

  app.get('/v1/reconciliations', async (req) => {
    const q = req.query ?? {};
    const status = q.status ? String(q.status) : 'pending';
    if (directAgent?.reconciler) {
      return {
        items: directAgent.reconciler.listReconciliations({
          sessionId: q.sessionId ? String(q.sessionId) : null,
          status,
          limit: Number(q.limit ?? 100),
        }),
      };
    }
    return { items: [] };
  });

  app.post('/v1/reconciliations/:id/resolve', async (req, reply) => {
    const body = req.body ?? {};
    const res = directAgent?.reconciler?.resolveReconciliation(req.params.id, {
      outcome: String(body.outcome || body.decision || 'abort'),
      note: String(body.note || body.reason || ''),
    });
    if (!res) {
      return reply.code(404).send({
        error: { code: 'RECONCILIATION_NOT_FOUND', message: 'Reconciliation not found', status: 404 },
      });
    }
    return res;
  });

  app.get('/v1/audit/integrity', async () =>
    audit ? audit.verifyIntegrity() : store.verifyIntegrity(),
  );

  app.get('/v1/audit/events', async (req) => {
    const q = req.query ?? {};
    if (audit) {
      return {
        items: audit.listAuditEvents({
          after: Number(q.after ?? 0),
          limit: Number(q.limit ?? 200),
          type: q.type ? String(q.type) : null,
        }),
      };
    }
    return { items: [] };
  });

  app.get('/v1/hooks/trust', async (req) => {
    const q = req.query ?? {};
    return {
      workspaceConfig: directAgent?.inspectHookConfig?.(q.filePath ? String(q.filePath) : null) ?? null,
      items:
        directAgent?.listHookTrust?.({
          workspaceRoot: q.workspaceRoot ? String(q.workspaceRoot) : null,
          status: q.status ? String(q.status) : null,
        }) ?? [],
    };
  });

  app.post('/v1/hooks/approve', async (req, reply) => {
    if (!directAgent?.approveHookConfig) {
      return reply.code(503).send({
        error: { code: 'HOOK_TRUST_UNAVAILABLE', message: 'Hook trust manager unavailable', status: 503 },
      });
    }
    const body = req.body ?? {};
    return directAgent.approveHookConfig(body.filePath ? String(body.filePath) : null, {
      workspaceRoot: body.workspaceRoot ? String(body.workspaceRoot) : undefined,
      expectedDigest: body.expectedDigest ? String(body.expectedDigest) : null,
      approvedBy: body.approvedBy ? String(body.approvedBy) : 'user',
      note: body.note ? String(body.note) : '',
    });
  });

  app.post('/v1/hooks/revoke', async (req, reply) => {
    if (!directAgent?.revokeHookConfig) {
      return reply.code(503).send({
        error: { code: 'HOOK_TRUST_UNAVAILABLE', message: 'Hook trust manager unavailable', status: 503 },
      });
    }
    const body = req.body ?? {};
    return directAgent.revokeHookConfig(body.filePath ? String(body.filePath) : null, {
      contentDigest: body.contentDigest ? String(body.contentDigest) : null,
      reason: body.reason ? String(body.reason) : 'revoked',
    });
  });
}
