import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { ExperienceMemoryService, ensureMemorySchema } from '../../src/memory/index.js';

function makeStore() {
  const db = new DatabaseSync(':memory:');
  return {
    db,
    tx(fn) {
      db.exec('BEGIN');
      try {
        const result = fn();
        db.exec('COMMIT');
        return result;
      } catch (error) {
        try { db.exec('ROLLBACK'); } catch { /* preserve original */ }
        throw error;
      }
    },
  };
}

test('memory lifecycle extracts, normalizes, validates, dedupes, persists, ranks, and isolates projects', () => {
  const store = makeStore();
  const memory = new ExperienceMemoryService({ store, projectId: 'project-a', clock: () => 1_000_000 });
  const extracted = memory.extract('[preference] Use TypeScript\n[lesson] Keep tests deterministic');
  assert.equal(extracted.length, 2);
  const normalized = extracted.map((item) => memory.normalize(item));
  assert.equal(memory.validate(normalized[0]).valid, true);
  const saved = memory.persist(memory.dedupe(normalized));
  assert.equal(saved.length, 2);
  const duplicate = memory.remember({ type: 'preference', key: 'language', content: 'Use   TypeScript', confidence: 0.9 });
  assert.equal(duplicate.length, 1);
  assert.equal(duplicate[0].contentHash, saved[0].contentHash);
  const other = new ExperienceMemoryService({ store, projectId: 'project-b', clock: () => 1_000_000 });
  assert.equal(other.retrieve({ query: 'TypeScript' }).items.length, 0);
  const result = memory.retrieve({ query: 'TypeScript', tokenBudget: 20 });
  assert.equal(result.items.length, 1);
  assert.ok(result.usedTokens <= 20);
  assert.equal(result.items[0].projectId, 'project-a');
  assert.ok(result.items[0].lastAccessedAt);
  store.db.close();
});

test('memory supports verified confidence, decay, feedback, invalidation, deletion, and conflict resolution', () => {
  const store = makeStore();
  let now = 2_000_000;
  const memory = new ExperienceMemoryService({ store, projectId: 'project-a', clock: () => now, halfLifeMs: 100 });
  const [old] = memory.remember({ type: 'fact', key: 'owner', content: 'old owner', confidence: 0.95 });
  now += 1_000;
  const [fresh] = memory.remember({ type: 'fact', key: 'owner', content: 'new owner', confidence: 1.0 });
  assert.equal(fresh.status, 'active');
  const ranked = memory.rank(
    [
      { ...old, updatedAt: now - 1_000 },
      { ...fresh, updatedAt: now },
    ],
    { query: 'owner', now },
  );
  assert.equal(ranked[0].id, fresh.id);
  assert.ok(ranked[0].decay > ranked[1].decay);
  assert.equal(memory.retrieve({ query: 'owner', tokenBudget: 100 }).items.length, 1);
  assert.equal(memory.retrieve({ projectId: 'project-a', includeInvalid: true, tokenBudget: 100 }).items.length, 2);
  const verified = memory.feedback({ id: fresh.id, action: 'verify' });
  assert.equal(verified.verified, true);
  assert.ok(verified.confidence >= 0.8);
  assert.equal(memory.feedback({ id: old.id, action: 'invalidate' }).status, 'invalid');
  assert.equal(memory.remove({ id: fresh.id }).status, 'deleted');
  assert.equal(memory.retrieve({ tokenBudget: 100 }).items.length, 0);
  store.db.close();
});

test('memory redacts secrets and rejects invalid candidates without touching permissions', () => {
  const store = makeStore();
  const memory = new ExperienceMemoryService({ store, projectId: 'project-a' });
  const [saved] = memory.remember({ content: 'api_key=supersecretvalue', type: 'note' });
  assert.doesNotMatch(saved.content, /supersecretvalue/);
  const invalid = memory.normalize({ projectId: 'project-a', type: 'not-a-type', content: 'x' });
  assert.equal(memory.validate(invalid).valid, false);
  assert.throws(() => memory.retrieve({ projectId: '' }), /projectId is required/);
  store.db.close();
});


