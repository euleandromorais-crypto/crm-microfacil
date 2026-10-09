import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool, queryOne, withTx } from '../db/pool.js';
import { audit } from '../lib/audit.js';
import { currentUser, requireRole } from '../lib/auth.js';
import { badRequest, notFound } from '../lib/errors.js';
import { parse } from '../lib/validate.js';

export const DEFAULT_STAGES = [
  { name: 'Novo lead', kind: 'open', probability: 5, color: '#64748b' },
  { name: 'Primeiro contato', kind: 'open', probability: 10, color: '#0ea5e9' },
  { name: 'Em atendimento', kind: 'open', probability: 20, color: '#6366f1' },
  { name: 'Qualificado', kind: 'open', probability: 40, color: '#8b5cf6' },
  { name: 'Proposta apresentada', kind: 'open', probability: 60, color: '#f59e0b' },
  { name: 'Em negociação', kind: 'open', probability: 80, color: '#f97316' },
  { name: 'Matrícula realizada', kind: 'won', probability: 100, color: '#16a34a' },
  { name: 'Perdido', kind: 'lost', probability: 0, color: '#dc2626' },
];

const stageSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().trim().min(1).max(80),
  kind: z.enum(['open', 'won', 'lost']).default('open'),
  probability: z.coerce.number().int().min(0).max(100).default(0),
  stale_after_days: z.preprocess((v) => (v === '' || v === undefined ? null : v), z.coerce.number().int().min(1).nullable()).default(null),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).default('#64748b'),
});

export async function createPipeline(db: any, name: string, stages = DEFAULT_STAGES, isDefault = false) {
  const p = await queryOne('INSERT INTO pipelines (name, is_default, position) VALUES ($1,$2,(SELECT COALESCE(max(position),0)+1 FROM pipelines)) RETURNING *', [name, isDefault], db);
  let pos = 1;
  for (const s of stages) {
    await db.query('INSERT INTO pipeline_stages (pipeline_id, name, position, kind, probability, color, stale_after_days) VALUES ($1,$2,$3,$4,$5,$6,$7)', [
      p!.id, s.name, pos++, s.kind, s.probability, s.color, (s as any).stale_after_days ?? null,
    ]);
  }
  return p!;
}

function validateStages(stages: z.infer<typeof stageSchema>[]) {
  if (!stages.some((s) => s.kind === 'open')) throw badRequest('O funil precisa de ao menos uma etapa aberta');
  if (!stages.some((s) => s.kind === 'won')) throw badRequest('O funil precisa de uma etapa de ganho (ex.: Matrícula realizada)');
  if (!stages.some((s) => s.kind === 'lost')) throw badRequest('O funil precisa de uma etapa de perda');
}

export async function pipelineRoutes(app: FastifyInstance) {
  app.get('/api/pipelines', async (req) => {
    currentUser(req);
    const pipelines = (await pool.query('SELECT * FROM pipelines ORDER BY active DESC, is_default DESC, position, id')).rows;
    const stages = (await pool.query(
      `SELECT s.*, (SELECT count(*) FROM opportunities o WHERE o.stage_id=s.id)::int AS opportunities FROM pipeline_stages s ORDER BY pipeline_id, position, id`,
    )).rows;
    return pipelines.map((p) => ({ ...p, stages: stages.filter((s) => s.pipeline_id === p.id) }));
  });

  app.post('/api/pipelines', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const body = parse(z.object({ name: z.string().trim().min(1).max(120), stages: z.array(stageSchema).optional(), is_default: z.boolean().default(false) }), req.body);
    if (body.stages) validateStages(body.stages);
    const p = await withTx(async (db) => {
      if (body.is_default) await db.query('UPDATE pipelines SET is_default=false');
      const hasAny = await queryOne('SELECT 1 AS x FROM pipelines LIMIT 1', [], db);
      return createPipeline(db, body.name, (body.stages as any) ?? DEFAULT_STAGES, body.is_default || !hasAny);
    });
    await audit({ userId: actor.id, action: 'pipeline.create', entityType: 'pipeline', entityId: p.id, changes: body, ip: req.ip });
    return p;
  });

  /** Atualiza o funil e suas etapas (cria, renomeia, reordena, remove) */
  app.put('/api/pipelines/:id', async (req) => {
    const actor = requireRole(req, 'admin', 'manager');
    const id = Number((req.params as any).id);
    const body = parse(
      z.object({
        name: z.string().trim().min(1).max(120),
        active: z.boolean().default(true),
        is_default: z.boolean().default(false),
        stages: z.array(stageSchema).min(3),
        /** etapa removida -> etapa destino das oportunidades */
        move_to: z.record(z.string(), z.number().int()).default({}),
      }),
      req.body,
    );
    validateStages(body.stages);
    const result = await withTx(async (db) => {
      const p = await queryOne('SELECT * FROM pipelines WHERE id=$1 FOR UPDATE', [id], db);
      if (!p) throw notFound('Funil não encontrado');
      if (!body.active && p.is_default) throw badRequest('Defina outro funil como padrão antes de desativar este');
      if (body.is_default && !p.is_default) await db.query('UPDATE pipelines SET is_default=false WHERE is_default');
      await db.query('UPDATE pipelines SET name=$2, active=$3, is_default=$4 OR is_default WHERE id=$1', [id, body.name, body.active, body.is_default]);
      const existing = (await db.query('SELECT id FROM pipeline_stages WHERE pipeline_id=$1', [id])).rows.map((r) => r.id);
      const keep = new Set<number>();
      let pos = 1;
      const idMap = new Map<number, number>();
      for (const s of body.stages) {
        if (s.id && existing.includes(s.id)) {
          await db.query('UPDATE pipeline_stages SET name=$2, kind=$3, probability=$4, stale_after_days=$5, color=$6, position=$7, archived=false WHERE id=$1', [
            s.id, s.name, s.kind, s.probability, s.stale_after_days, s.color, pos++,
          ]);
          keep.add(s.id);
          idMap.set(s.id, s.id);
        } else {
          const r = await queryOne('INSERT INTO pipeline_stages (pipeline_id, name, kind, probability, stale_after_days, color, position) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [
            id, s.name, s.kind, s.probability, s.stale_after_days, s.color, pos++,
          ], db);
          keep.add(r!.id);
        }
      }
      for (const stageId of existing.filter((x) => !keep.has(x))) {
        const count = await queryOne('SELECT count(*)::int AS n FROM opportunities WHERE stage_id=$1', [stageId], db);
        if (count!.n > 0) {
          const target = body.move_to[String(stageId)];
          if (!target || !keep.has(target)) {
            throw badRequest('Há oportunidades em uma etapa removida. Escolha a etapa de destino para elas.', { stage_id: stageId, count: count!.n });
          }
          const tk = await queryOne('SELECT kind FROM pipeline_stages WHERE id=$1', [target], db);
          await db.query(`UPDATE opportunities SET stage_id=$2, stage_entered_at=now(), status=$3, updated_at=now() WHERE stage_id=$1`, [stageId, target, tk!.kind === 'open' ? 'open' : tk!.kind]);
          await db.query('UPDATE opportunity_stage_history SET from_stage_id=NULL WHERE from_stage_id=$1', [stageId]);
        }
        // mantém o histórico: etapas com histórico são arquivadas em vez de apagadas
        const hist = await queryOne('SELECT 1 AS x FROM opportunity_stage_history WHERE to_stage_id=$1 LIMIT 1', [stageId], db);
        if (hist) await db.query('UPDATE pipeline_stages SET archived=true, position=1000+position WHERE id=$1', [stageId]);
        else await db.query('DELETE FROM pipeline_stages WHERE id=$1', [stageId]);
      }
      return queryOne('SELECT * FROM pipelines WHERE id=$1', [id], db);
    });
    await audit({ userId: actor.id, action: 'pipeline.update', entityType: 'pipeline', entityId: id, changes: { name: body.name, stages: body.stages.map((s) => s.name) }, ip: req.ip });
    return result;
  });

  app.delete('/api/pipelines/:id', async (req) => {
    const actor = requireRole(req, 'admin');
    const id = Number((req.params as any).id);
    const p = await queryOne('SELECT * FROM pipelines WHERE id=$1', [id]);
    if (!p) throw notFound();
    if (p.is_default) throw badRequest('Não é possível excluir o funil padrão');
    const n = await queryOne('SELECT count(*)::int AS n FROM opportunities WHERE pipeline_id=$1', [id]);
    if (n!.n > 0) {
      await pool.query('UPDATE pipelines SET active=false WHERE id=$1', [id]);
      await audit({ userId: actor.id, action: 'pipeline.deactivate', entityType: 'pipeline', entityId: id, ip: req.ip });
      return { ok: true, deactivated: true, message: 'O funil possui oportunidades e foi apenas desativado.' };
    }
    await pool.query('DELETE FROM pipelines WHERE id=$1', [id]);
    await audit({ userId: actor.id, action: 'pipeline.delete', entityType: 'pipeline', entityId: id, ip: req.ip });
    return { ok: true };
  });
}
