/**
 * Migrações do banco. Cada entrada roda uma vez, em ordem, dentro de uma
 * transação, e `PRAGMA user_version` guarda onde paramos.
 *
 * Convenção: colunas com sufixo `_enc` guardam BLOBs selados (AES-256-GCM).
 * Tudo que não tem `_enc` fica em claro porque o banco precisa indexar ou
 * ordenar por aquilo (carimbos de tempo, tipos, contadores). O que exatamente
 * fica visível está documentado em docs/SEGURANCA.md.
 */

export const MIGRATIONS: Array<{ version: number; name: string; sql: string }> = [
  {
    version: 1,
    name: 'núcleo: conversas, mensagens, memória, permissões, cofre',
    sql: `
    CREATE TABLE conversations (
      id            TEXT PRIMARY KEY,
      channel       TEXT NOT NULL,
      title_enc     BLOB,
      summary_enc   BLOB,
      started_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      message_count INTEGER NOT NULL DEFAULT 0,
      archived      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_conversations_updated ON conversations(updated_at DESC);
    CREATE INDEX idx_conversations_channel ON conversations(channel, updated_at DESC);

    CREATE TABLE messages (
      id              TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      seq             INTEGER NOT NULL,
      role            TEXT NOT NULL,
      content_enc     BLOB NOT NULL,
      blocks_enc      BLOB,
      channel         TEXT NOT NULL,
      tokens_in       INTEGER NOT NULL DEFAULT 0,
      tokens_out      INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_messages_seq ON messages(conversation_id, seq);
    CREATE INDEX idx_messages_created ON messages(created_at DESC);

    CREATE TABLE memories (
      id              TEXT PRIMARY KEY,
      kind            TEXT NOT NULL,
      subject         TEXT NOT NULL DEFAULT '',
      content_enc     BLOB NOT NULL,
      importance      REAL NOT NULL DEFAULT 0.5,
      confidence      REAL NOT NULL DEFAULT 0.8,
      source          TEXT NOT NULL DEFAULT 'conversa',
      conversation_id TEXT,
      embedding       BLOB,
      created_at      INTEGER NOT NULL,
      updated_at      INTEGER NOT NULL,
      last_used_at    INTEGER,
      use_count       INTEGER NOT NULL DEFAULT 0,
      pinned          INTEGER NOT NULL DEFAULT 0,
      expires_at      INTEGER,
      superseded_by   TEXT
    );
    CREATE INDEX idx_memories_kind ON memories(kind, importance DESC);
    CREATE INDEX idx_memories_live ON memories(superseded_by, updated_at DESC);
    CREATE INDEX idx_memories_subject ON memories(subject);

    CREATE TABLE memory_terms (
      memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
      term      TEXT NOT NULL,
      PRIMARY KEY (memory_id, term)
    );
    CREATE INDEX idx_memory_terms_term ON memory_terms(term);

    CREATE TABLE entities (
      id         TEXT PRIMARY KEY,
      type       TEXT NOT NULL,
      key_hash   TEXT NOT NULL,
      data_enc   BLOB NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_entities_key ON entities(type, key_hash);

    CREATE TABLE capabilities (
      id           TEXT PRIMARY KEY,
      capability   TEXT NOT NULL,
      scope        TEXT NOT NULL DEFAULT '*',
      decision     TEXT NOT NULL,
      risk         TEXT NOT NULL DEFAULT 'medium',
      granted_at   INTEGER NOT NULL,
      expires_at   INTEGER,
      revoked_at   INTEGER,
      note_enc     BLOB,
      use_count    INTEGER NOT NULL DEFAULT 0,
      last_used_at INTEGER
    );
    CREATE UNIQUE INDEX idx_capabilities_unique ON capabilities(capability, scope);
    CREATE INDEX idx_capabilities_live ON capabilities(revoked_at, capability);

    CREATE TABLE audit_log (
      id              TEXT PRIMARY KEY,
      at              INTEGER NOT NULL,
      actor           TEXT NOT NULL,
      action          TEXT NOT NULL,
      capability      TEXT,
      scope           TEXT,
      decision        TEXT,
      ok              INTEGER NOT NULL DEFAULT 1,
      conversation_id TEXT,
      duration_ms     INTEGER,
      detail_enc      BLOB
    );
    CREATE INDEX idx_audit_at ON audit_log(at DESC);
    CREATE INDEX idx_audit_action ON audit_log(action, at DESC);

    CREATE TABLE vault_items (
      name         TEXT PRIMARY KEY,
      kind         TEXT NOT NULL DEFAULT 'senha',
      value_enc    BLOB NOT NULL,
      meta_enc     BLOB,
      created_at   INTEGER NOT NULL,
      updated_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      use_count    INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE kv (
      key        TEXT PRIMARY KEY,
      value_enc  BLOB NOT NULL,
      updated_at INTEGER NOT NULL
    );
    `,
  },
  {
    version: 2,
    name: 'vida prática: lembretes, tarefas, processos, monitores, observações',
    sql: `
    CREATE TABLE reminders (
      id           TEXT PRIMARY KEY,
      title_enc    BLOB NOT NULL,
      body_enc     BLOB,
      due_at       INTEGER NOT NULL,
      lead_minutes INTEGER NOT NULL DEFAULT 60,
      rrule        TEXT,
      kind         TEXT NOT NULL DEFAULT 'compromisso',
      status       TEXT NOT NULL DEFAULT 'pendente',
      created_at   INTEGER NOT NULL,
      notified_at  INTEGER,
      done_at      INTEGER,
      source       TEXT NOT NULL DEFAULT 'conversa',
      related_id   TEXT
    );
    CREATE INDEX idx_reminders_due ON reminders(status, due_at);

    CREATE TABLE tasks (
      id         TEXT PRIMARY KEY,
      title_enc  BLOB NOT NULL,
      notes_enc  BLOB,
      status     TEXT NOT NULL DEFAULT 'aberta',
      priority   INTEGER NOT NULL DEFAULT 2,
      due_at     INTEGER,
      project    TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      done_at    INTEGER
    );
    CREATE INDEX idx_tasks_status ON tasks(status, priority, due_at);

    CREATE TABLE processes (
      id               TEXT PRIMARY KEY,
      number           TEXT NOT NULL,
      tribunal         TEXT NOT NULL DEFAULT '',
      label_enc        BLOB,
      data_enc         BLOB,
      active           INTEGER NOT NULL DEFAULT 1,
      last_checked_at  INTEGER,
      last_movement_at INTEGER,
      last_hash        TEXT,
      created_at       INTEGER NOT NULL,
      updated_at       INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX idx_processes_number ON processes(number);
    CREATE INDEX idx_processes_active ON processes(active, last_checked_at);

    CREATE TABLE process_movements (
      id         TEXT PRIMARY KEY,
      process_id TEXT NOT NULL REFERENCES processes(id) ON DELETE CASCADE,
      at         INTEGER NOT NULL,
      hash       TEXT NOT NULL,
      content_enc BLOB NOT NULL,
      notified   INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX idx_movements_hash ON process_movements(process_id, hash);
    CREATE INDEX idx_movements_at ON process_movements(at DESC);

    CREATE TABLE monitors (
      id           TEXT PRIMARY KEY,
      kind         TEXT NOT NULL,
      label        TEXT NOT NULL DEFAULT '',
      config_enc   BLOB NOT NULL,
      state_enc    BLOB,
      cron         TEXT NOT NULL,
      enabled      INTEGER NOT NULL DEFAULT 1,
      last_run_at  INTEGER,
      last_status  TEXT,
      created_at   INTEGER NOT NULL
    );
    CREATE INDEX idx_monitors_enabled ON monitors(enabled, kind);

    CREATE TABLE observations (
      id          TEXT PRIMARY KEY,
      source      TEXT NOT NULL,
      at          INTEGER NOT NULL,
      app         TEXT,
      hash        TEXT NOT NULL,
      content_enc BLOB NOT NULL,
      processed   INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX idx_observations_at ON observations(at DESC);
    CREATE INDEX idx_observations_hash ON observations(hash);
    CREATE INDEX idx_observations_pending ON observations(processed, at);
    `,
  },
  {
    version: 3,
    name: 'fila de trabalhos em segundo plano',
    sql: `
    CREATE TABLE jobs (
      id          TEXT PRIMARY KEY,
      kind        TEXT NOT NULL,
      payload_enc BLOB,
      run_at      INTEGER NOT NULL,
      attempts    INTEGER NOT NULL DEFAULT 0,
      status      TEXT NOT NULL DEFAULT 'pendente',
      last_error  TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE INDEX idx_jobs_ready ON jobs(status, run_at);
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
