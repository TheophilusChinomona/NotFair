import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import Database from "better-sqlite3";
import { MIGRATIONS } from "./migrations";

const DEFAULT_DATA_DIR = process.env.NOTFAIR_CMO_DATA_DIR ?? join(homedir(), ".notfair-cmo");
const DB_PATH = join(DEFAULT_DATA_DIR, "db.sqlite");

// PostgreSQL Schema Definition (Consolidated to migration 015)
const CONSOLIDATED_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (
  name       TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  id           TEXT PRIMARY KEY,
  slug         TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  archived_at  TEXT,
  google_ads_account_id TEXT,
  meta_ads_account_id TEXT,
  gsc_property_id TEXT,
  website_url TEXT,
  codebase_path TEXT,
  harness_adapter TEXT NOT NULL DEFAULT 'claude-code-local',
  hidden_mcp_preset_keys_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS tasks (
  id                TEXT PRIMARY KEY,
  project_slug      TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL,
  brief             TEXT NOT NULL,
  success_criteria  TEXT,
  deadline_iso      TEXT,
  status            TEXT NOT NULL CHECK (status IN ('proposed','approved','working','blocked','done','failed','cancelled')),
  result_json       TEXT,
  error_message     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  title             TEXT,
  thread_id         TEXT,
  assigner_agent_id TEXT,
  display_id        TEXT UNIQUE,
  blocked_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS approvals (
  id                TEXT PRIMARY KEY,
  project_slug      TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  agent_id          TEXT NOT NULL,
  task_id           TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  action_summary    TEXT NOT NULL,
  action_type       TEXT NOT NULL CHECK (action_type IN ('spend','content_publishing','new_channel','bid_change','audience_change','other')),
  cost_estimate_usd DOUBLE PRECISION NOT NULL DEFAULT 0,
  reasoning         TEXT,
  payload_json      TEXT NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('pending','revision_requested','approved','rejected','expired')),
  decision_note     TEXT,
  decided_by_kind   TEXT CHECK (decided_by_kind IN ('user','agent','policy')),
  decided_by_id     TEXT,
  created_at        TEXT NOT NULL,
  resolved_at       TEXT
);

CREATE TABLE IF NOT EXISTS cost_events (
  id           TEXT PRIMARY KEY,
  project_slug TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  agent_id     TEXT,
  source       TEXT NOT NULL CHECK (source IN ('llm','google_ads','gsc','other')),
  amount_usd   DOUBLE PRECISION NOT NULL,
  ref          TEXT,
  occurred_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  id                TEXT PRIMARY KEY,
  project_slug      TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  provider          TEXT NOT NULL CHECK (provider IN ('google_ads','gsc')),
  account_label     TEXT NOT NULL,
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  scope             TEXT NOT NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(project_slug, provider, account_label)
);

CREATE TABLE IF NOT EXISTS agent_actions (
  id            TEXT PRIMARY KEY,
  project_slug  TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  task_id       TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  action_type   TEXT NOT NULL,
  summary       TEXT NOT NULL,
  reasoning     TEXT,
  payload_json  TEXT,
  occurred_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sequence_runs (
  id            TEXT PRIMARY KEY,
  project_slug  TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  sequence_kind TEXT NOT NULL,
  cursor        TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('pending','running','succeeded','failed','cancelled')),
  payload_json  TEXT,
  last_tick_at  TEXT,
  next_tick_at  TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_tokens (
  id                TEXT PRIMARY KEY,
  project_slug      TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  server_name       TEXT NOT NULL,
  account_label     TEXT NOT NULL DEFAULT '',
  access_token_enc  TEXT NOT NULL,
  refresh_token_enc TEXT,
  expires_at        TEXT,
  scope             TEXT,
  metadata_json     TEXT,
  token_endpoint    TEXT,
  client_id         TEXT,
  client_secret     TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  UNIQUE(project_slug, server_name, account_label)
);

CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id            TEXT PRIMARY KEY,
  project_slug  TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  agent_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  cron_expr     TEXT NOT NULL,
  message       TEXT NOT NULL,
  enabled       INTEGER NOT NULL DEFAULT 1,
  last_run_at   TEXT,
  next_run_at   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(project_slug, agent_id, name)
);

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  project_slug        TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL,
  label               TEXT NOT NULL,
  harness_adapter     TEXT NOT NULL,
  harness_session_id  TEXT,
  task_id             TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE(project_slug, agent_id, label)
);

CREATE TABLE IF NOT EXISTS transcript_events (
  id            TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq           INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('user','delta','tool','lifecycle','final','error')),
  payload_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS scheduled_job_runs (
  id              TEXT PRIMARY KEY,
  scheduled_job_id TEXT NOT NULL REFERENCES scheduled_jobs(id) ON DELETE CASCADE,
  started_at      TEXT NOT NULL,
  finished_at     TEXT,
  status          TEXT NOT NULL CHECK (status IN ('running','done','failed')),
  error_message   TEXT,
  summary         TEXT
);

CREATE TABLE IF NOT EXISTS user_mcp_servers (
  id            TEXT PRIMARY KEY,
  project_slug  TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  key           TEXT NOT NULL,
  display_name  TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  resource_url  TEXT NOT NULL,
  discovery_url TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE(project_slug, key)
);

CREATE TABLE IF NOT EXISTS questions (
  id                  TEXT PRIMARY KEY,
  project_slug        TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  agent_id            TEXT NOT NULL,
  task_id             TEXT REFERENCES tasks(id) ON DELETE SET NULL,
  prompt              TEXT NOT NULL,
  options_json        TEXT NOT NULL DEFAULT '[]',
  status              TEXT NOT NULL CHECK (status IN ('pending','answered','cancelled')),
  answer_option_index INTEGER,
  answer_text         TEXT,
  resolved_by_kind    TEXT CHECK (resolved_by_kind IN ('user','system')),
  created_at          TEXT NOT NULL,
  resolved_at         TEXT
);

CREATE TABLE IF NOT EXISTS approval_comments (
  id          TEXT PRIMARY KEY,
  approval_id TEXT NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  author_kind TEXT NOT NULL CHECK (author_kind IN ('user','agent','system')),
  author_id   TEXT,
  body        TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_policies (
  id              TEXT PRIMARY KEY,
  project_slug    TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
  action_type     TEXT NOT NULL CHECK (action_type IN ('spend','content_publishing','new_channel','bid_change','audience_change','other')),
  agent_id        TEXT,
  max_cost_usd    DOUBLE PRECISION,
  auto_decision   TEXT NOT NULL CHECK (auto_decision IN ('approve','reject')),
  note            TEXT,
  created_at      TEXT NOT NULL,
  created_by_kind TEXT NOT NULL CHECK (created_by_kind IN ('user','agent')),
  created_by_id   TEXT
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_slug);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(project_slug, status);
CREATE INDEX IF NOT EXISTS idx_tasks_blocked_by ON tasks(blocked_by_task_id) WHERE blocked_by_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approvals_pending ON approvals(project_slug, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_approvals_actionable ON approvals(project_slug, status) WHERE status IN ('pending','revision_requested');
CREATE INDEX IF NOT EXISTS idx_approvals_task ON approvals(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_cost_events_project_time ON cost_events(project_slug, occurred_at);
CREATE INDEX IF NOT EXISTS idx_agent_actions_project_time ON agent_actions(project_slug, occurred_at);
CREATE INDEX IF NOT EXISTS idx_mcp_tokens_project ON mcp_tokens(project_slug);
CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_next ON scheduled_jobs(enabled, next_run_at);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(project_slug, agent_id);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transcript_events_session ON transcript_events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_scheduled_job_runs_job ON scheduled_job_runs(scheduled_job_id, started_at);
CREATE INDEX IF NOT EXISTS idx_user_mcp_servers_project ON user_mcp_servers(project_slug);
CREATE INDEX IF NOT EXISTS idx_questions_pending ON questions(project_slug, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_questions_task ON questions(task_id) WHERE task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_approval_comments_approval ON approval_comments(approval_id, created_at);
CREATE INDEX IF NOT EXISTS idx_approval_policies_project ON approval_policies(project_slug, action_type);

CREATE TABLE IF NOT EXISTS "user" (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  "emailVerified" BOOLEAN NOT NULL,
  image TEXT,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS "session" (
  id TEXT PRIMARY KEY,
  "expiresAt" TIMESTAMP NOT NULL,
  token TEXT NOT NULL UNIQUE,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL,
  "ipAddress" TEXT,
  "userAgent" TEXT,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS "account" (
  id TEXT PRIMARY KEY,
  "accountId" TEXT NOT NULL,
  "providerId" TEXT NOT NULL,
  "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  "accessToken" TEXT,
  "refreshToken" TEXT,
  "idToken" TEXT,
  "expiresAt" TIMESTAMP,
  "password" TEXT,
  "createdAt" TIMESTAMP NOT NULL,
  "updatedAt" TIMESTAMP NOT NULL
);

CREATE TABLE IF NOT EXISTS "verification" (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  "expiresAt" TIMESTAMP NOT NULL,
  "createdAt" TIMESTAMP,
  "updatedAt" TIMESTAMP
);
`;

const workerCode = `
const { parentPort, workerData } = require('node:worker_threads');
const { Client } = require('pg');

let client = null;

async function init() {
  client = new Client({ connectionString: workerData.connectionString });
  await client.connect();
  
  // Setup database tables if not existing
  const migrationCheck = await client.query(\`
    SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_name = '_migrations'
    );
  \`);
  
  const exists = migrationCheck.rows[0].exists;
  if (!exists) {
    console.log("Initializing PostgreSQL database schema...");
    await client.query(workerData.schemaSql);
    console.log("Database schema initialized successfully!");
    
    // Backfill _migrations
    const migrationNames = [
      "001_init.sql", "002_google_ads_account.sql", "003_tasks_orchestration.sql",
      "004_task_display_id.sql", "005_drop_guardrails.sql", "006_approvals_v2.sql",
      "007_unify_task_status_vocab.sql", "008_project_brief_and_task_blocks.sql",
      "009_questions.sql", "010_harness_adapter.sql", "011_user_mcp_servers.sql",
      "012_hidden_mcp_presets.sql", "013_mcp_token_oauth_client.sql",
      "014_scheduled_job_run_summary.sql", "015_meta_ads_and_gsc_accounts.sql"
    ];
    for (const name of migrationNames) {
      await client.query("INSERT INTO _migrations (name, applied_at) VALUES ($1, $2)", [
        name, new Date().toISOString()
      ]);
    }
  }
}

init().then(() => {
  const sharedBuffer = workerData.sharedBuffer;
  const int32Array = new Int32Array(sharedBuffer);
  const uint8Array = new Uint8Array(sharedBuffer, 8);

  parentPort.on('message', async (msg) => {
    if (msg === 'stop') {
      if (client) await client.end();
      process.exit(0);
    }
    
    if (msg === 'query') {
      try {
        const reqLen = int32Array[1];
        const decoder = new TextDecoder();
        const reqStr = decoder.decode(uint8Array.subarray(0, reqLen));
        const { sql, params } = JSON.parse(reqStr);
        
        const res = await client.query(sql, params);
        const resStr = JSON.stringify({ rows: res.rows, rowCount: res.rowCount });
        
        const encoder = new TextEncoder();
        const encoded = encoder.encode(resStr);
        
        if (encoded.length > uint8Array.length) {
          throw new Error("Query result exceeded shared memory buffer size");
        }
        
        uint8Array.set(encoded);
        int32Array[1] = encoded.length;
        int32Array[0] = 2; // SUCCESS
      } catch (err) {
        const errStr = err.message || String(err);
        const encoder = new TextEncoder();
        const encoded = encoder.encode(errStr);
        uint8Array.set(encoded.subarray(0, uint8Array.length));
        int32Array[1] = Math.min(encoded.length, uint8Array.length);
        int32Array[0] = 3; // ERROR
      } finally {
        Atomics.notify(int32Array, 0);
      }
    }
  });
}).catch(err => {
  console.error("Database worker initialization failed:", err);
  process.exit(1);
});
`;

export interface DbStatement {
  run(...params: any[]): { changes: number };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

export interface DbClient {
  prepare(sql: string): DbStatement;
  transaction<T extends Function>(fn: T): T;
  exec(sql: string): void;
  pragma(pragmaString: string, options?: { simple?: boolean }): any;
  close(): void;
}

let cached: DbClient | null = null;

let sharedBuffer: SharedArrayBuffer | null = null;
let int32Array: Int32Array | null = null;
let uint8Array: Uint8Array | null = null;
let worker: Worker | null = null;

function initPgWorker(connectionString: string) {
  sharedBuffer = new SharedArrayBuffer(16 * 1024 * 1024); // 16MB
  int32Array = new Int32Array(sharedBuffer);
  uint8Array = new Uint8Array(sharedBuffer, 8);
  
  worker = new Worker(workerCode, {
    eval: true,
    workerData: {
      connectionString,
      sharedBuffer,
      schemaSql: CONSOLIDATED_SCHEMA_SQL
    }
  });
  
  worker.on("error", (err) => {
    console.error("Database worker error:", err);
  });
}

function pgQuery(sql: string, params: any[]) {
  if (!worker || !int32Array || !uint8Array) {
    throw new Error("Database worker not initialized");
  }
  
  const reqStr = JSON.stringify({ sql, params });
  const encoder = new TextEncoder();
  const encoded = encoder.encode(reqStr);
  
  if (encoded.length > uint8Array.length) {
    throw new Error("Query payload exceeded shared memory buffer size");
  }
  
  uint8Array.set(encoded);
  int32Array[1] = encoded.length;
  int32Array[0] = 1; // QUERY_PENDING
  
  worker.postMessage("query");
  Atomics.wait(int32Array, 0, 1);
  
  const status = int32Array[0];
  const resLen = int32Array[1];
  const decoder = new TextDecoder();
  const resStr = decoder.decode(uint8Array.subarray(0, resLen));
  
  if (status === 3) {
    throw new Error(`Database Query Error: ${resStr}`);
  }
  
  const response = JSON.parse(resStr);
  return {
    rows: response.rows,
    rowCount: response.rowCount
  };
}

function pgPrepare(sql: string): DbStatement {
  // Convert SQLite-style '?' placeholders to PostgreSQL '$1', '$2', etc.
  let index = 1;
  const pgSql = sql.replace(/\?/g, () => `$${index++}`);
  
  return {
    run(...params: any[]) {
      const res = pgQuery(pgSql, params);
      return { changes: res.rowCount ?? 0 };
    },
    get(...params: any[]) {
      const res = pgQuery(pgSql, params);
      return res.rows[0] ?? null;
    },
    all(...params: any[]) {
      const res = pgQuery(pgSql, params);
      return res.rows;
    }
  };
}

class PostgresDbClient implements DbClient {
  prepare(sql: string): DbStatement {
    return pgPrepare(sql);
  }
  transaction<T extends Function>(fn: T): T {
    const wrapped = (...args: any[]) => {
      pgQuery("BEGIN", []);
      try {
        const result = fn(...args);
        pgQuery("COMMIT", []);
        return result;
      } catch (err) {
        pgQuery("ROLLBACK", []);
        throw err;
      }
    };
    return wrapped as unknown as T;
  }
  exec(sql: string): void {
    pgQuery(sql, []);
  }
  pragma(pragmaString: string, options?: { simple?: boolean }): any {
    if (pragmaString.includes("foreign_keys = OFF")) {
      pgQuery("SET CONSTRAINTS ALL DEFERRED", []);
    } else if (pragmaString.includes("foreign_keys = ON")) {
      pgQuery("SET CONSTRAINTS ALL IMMEDIATE", []);
    }
    return 1;
  }
  close(): void {}
}

class SqliteDbClient implements DbClient {
  private db: Database.Database;
  constructor(db: Database.Database) {
    this.db = db;
  }
  prepare(sql: string): DbStatement {
    const stmt = this.db.prepare(sql);
    return {
      run(...params: any[]) {
        const info = stmt.run(...params);
        return { changes: info.changes };
      },
      get(...params: any[]) {
        return stmt.get(...params);
      },
      all(...params: any[]) {
        return stmt.all(...params);
      }
    };
  }
  transaction<T extends Function>(fn: T): T {
    return this.db.transaction(fn as any) as any;
  }
  exec(sql: string): void {
    this.db.exec(sql);
  }
  pragma(pragmaString: string, options?: { simple?: boolean }): any {
    return this.db.pragma(pragmaString, options);
  }
  close(): void {
    this.db.close();
  }
}

export function getDb(): DbClient {
  if (cached) return cached;

  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl && (dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://"))) {
    initPgWorker(dbUrl);
    cached = new PostgresDbClient();
    return cached;
  }

  if (!existsSync(DEFAULT_DATA_DIR)) {
    mkdirSync(DEFAULT_DATA_DIR, { recursive: true, mode: 0o700 });
  }

  const sqliteDb = new Database(DB_PATH);
  sqliteDb.pragma("journal_mode = WAL");
  sqliteDb.pragma("foreign_keys = ON");
  sqliteDb.pragma("busy_timeout = 5000");

  applyMigrations(sqliteDb);

  cached = new SqliteDbClient(sqliteDb);
  return cached;
}

export function getDbPath(): string {
  return DB_PATH;
}

function applyMigrations(db: Database.Database): void {
  // Ensure Better-Auth tables exist in SQLite
  db.exec(`
    CREATE TABLE IF NOT EXISTS "user" (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      "emailVerified" INTEGER NOT NULL,
      image TEXT,
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "session" (
      id TEXT PRIMARY KEY,
      "expiresAt" TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL,
      "ipAddress" TEXT,
      "userAgent" TEXT,
      "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
    );
    CREATE TABLE IF NOT EXISTS "account" (
      id TEXT PRIMARY KEY,
      "accountId" TEXT NOT NULL,
      "providerId" TEXT NOT NULL,
      "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
      "accessToken" TEXT,
      "refreshToken" TEXT,
      "idToken" TEXT,
      "expiresAt" TEXT,
      "password" TEXT,
      "createdAt" TEXT NOT NULL,
      "updatedAt" TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS "verification" (
      id TEXT PRIMARY KEY,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      "expiresAt" TEXT NOT NULL,
      "createdAt" TEXT,
      "updatedAt" TEXT
    );
    CREATE TABLE IF NOT EXISTS _migrations (
      name       TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    (db.prepare("SELECT name FROM _migrations").all() as { name: string }[]).map(
      (row) => row.name,
    ),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO _migrations (name, applied_at) VALUES (?, ?)").run(
        migration.name,
        new Date().toISOString(),
      );
    });
    tx();
  }
}
