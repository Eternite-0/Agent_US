export const MEMORY_SCHEMA_VERSION = 2;

export const MEMORY_TYPES = Object.freeze([
  'fact',
  'preference',
  'lesson',
  'decision',
  'constraint',
  'note',
]);

export const MEMORY_STATUSES = Object.freeze(['active', 'invalid', 'deleted', 'expired']);

export function getMemoryDb(store) {
  const db = store?.db ?? store;
  if (!db || typeof db.exec !== 'function' || typeof db.prepare !== 'function') {
    throw new TypeError('ExperienceMemoryService requires an injected SQLite-like store');
  }
  return db;
}

export function ensureMemorySchema(store) {
  const db = getMemoryDb(store);
  db.exec(`
    CREATE TABLE IF NOT EXISTS experience_memory (
      id TEXT PRIMARY KEY,
      projectId TEXT NOT NULL,
      type TEXT NOT NULL,
      memoryKey TEXT NOT NULL DEFAULT '',
      content TEXT NOT NULL,
      normalizedContent TEXT NOT NULL,
      contentHash TEXT NOT NULL,
      memoryClass TEXT,
      scopeType TEXT,
      scopeId TEXT,
      sourceArtifact TEXT,
      verificationEvidence TEXT,
      tags TEXT NOT NULL DEFAULT '[]',
      confidence REAL NOT NULL DEFAULT 0.5 CHECK(confidence >= 0 AND confidence <= 1),
      verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0, 1)),
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'unknown',
      tokenEstimate INTEGER NOT NULL DEFAULT 0,
      positiveFeedback INTEGER NOT NULL DEFAULT 0,
      negativeFeedback INTEGER NOT NULL DEFAULT 0,
      invalidReason TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      supersedesId TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      lastAccessedAt INTEGER,
      expiresAt INTEGER
    );
  `);
  const columns = new Set(db.prepare('PRAGMA table_info(experience_memory)').all().map((row) => row.name));
  for (const [name, definition] of [
    ['memoryClass', 'TEXT'],
    ['scopeType', 'TEXT'],
    ['scopeId', 'TEXT'],
    ['sourceArtifact', 'TEXT'],
    ['verificationEvidence', 'TEXT'],
  ]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE experience_memory ADD COLUMN ${name} ${definition}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS experience_memory_project_status
      ON experience_memory(projectId, status, updatedAt DESC);
    CREATE INDEX IF NOT EXISTS experience_memory_project_key
      ON experience_memory(projectId, type, memoryKey, status);
    CREATE INDEX IF NOT EXISTS experience_memory_project_hash
      ON experience_memory(projectId, contentHash, status);
    CREATE INDEX IF NOT EXISTS experience_memory_scope
      ON experience_memory(projectId, scopeType, scopeId, status);
  `);
  return db;
}
