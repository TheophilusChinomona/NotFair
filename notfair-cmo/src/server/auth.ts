import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins/admin";
import { Pool } from "pg";
import Database from "better-sqlite3";
import type { BetterAuthOptions } from "better-auth";
import { getDb } from "@/server/db/db";

const DEFAULT_DATA_DIR = process.env.NOTFAIR_CMO_DATA_DIR ?? join(homedir(), ".notfair-cmo");
const DB_PATH = join(DEFAULT_DATA_DIR, "db.sqlite");

/**
 * Resolve the auth secret:
 * - Production (NODE_ENV=production): MUST be set via env, hard-fail otherwise.
 * - Local dev: mint + persist to a file at DATA_DIR/auth-secret with 0o600 perms.
 */
function resolveAuthSecret(): string {
  const fromEnv = process.env.BETTER_AUTH_SECRET;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "BETTER_AUTH_SECRET is required in production. Set it in the container environment (e.g. .env).",
    );
  }
  // Local dev — mint + persist a per-machine secret
  const dataDir = process.env.NOTFAIR_CMO_DATA_DIR ?? join(homedir(), ".notfair-cmo");
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  }
  const secretPath = join(dataDir, "auth-secret");
  if (existsSync(secretPath)) {
    const value = readFileSync(secretPath, "utf8").trim();
    if (value) return value;
  }
  const minted = randomBytes(32).toString("hex");
  writeFileSync(secretPath, `${minted}\n`, { mode: 0o600 });
  return minted;
}

const dbUrl = process.env.DATABASE_URL;
const isPostgres = dbUrl && (dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://"));

type DatabaseConfig =
  | { db: Pool; type: "postgres" }
  | { db: Database.Database; type: "sqlite" };

const databaseConfig: DatabaseConfig = isPostgres
  ? { db: new Pool({ connectionString: dbUrl }), type: "postgres" }
  : (() => {
      if (!existsSync(DEFAULT_DATA_DIR)) {
        mkdirSync(DEFAULT_DATA_DIR, { recursive: true, mode: 0o700 });
      }
      return { db: new Database(DB_PATH), type: "sqlite" } satisfies DatabaseConfig;
    })();

export const auth = betterAuth({
  database: databaseConfig,
  emailAndPassword: {
    enabled: true,
  },
  secret: resolveAuthSecret(),
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: [
    "http://localhost:3326",
    ...(process.env.BETTER_AUTH_URL ? [process.env.BETTER_AUTH_URL] : []),
  ],
  plugins: [admin()],
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          const row = getDb().prepare('SELECT COUNT(*) AS n FROM "user"').get() as { n: number };
          if (row.n > 0) return false;
          return { data: { ...user, role: "admin" } };
        },
      },
    },
  },
} satisfies BetterAuthOptions);

const AUTH_TABLES_DDL = [
  `CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    "emailVerified" INTEGER NOT NULL DEFAULT 0,
    image TEXT,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    role TEXT DEFAULT 'user',
    banned INTEGER DEFAULT 0,
    "banReason" TEXT,
    "banExpires" INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS "session" (
    id TEXT PRIMARY KEY,
    "expiresAt" TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    "createdAt" TEXT NOT NULL,
    "updatedAt" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "account" (
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
  )`,
  `CREATE TABLE IF NOT EXISTS "verification" (
    id TEXT PRIMARY KEY,
    identifier TEXT NOT NULL,
    value TEXT NOT NULL,
    "expiresAt" TEXT NOT NULL,
    "createdAt" TEXT,
    "updatedAt" TEXT
  )`,
];

const ADMIN_COLUMNS: { name: string; ddl: string }[] = [
  { name: "role",           ddl: `ALTER TABLE "user" ADD COLUMN role TEXT DEFAULT 'user'` },
  { name: "banned",         ddl: `ALTER TABLE "user" ADD COLUMN banned INTEGER DEFAULT 0` },
  { name: "banReason",      ddl: `ALTER TABLE "user" ADD COLUMN "banReason" TEXT` },
  { name: "banExpires",     ddl: `ALTER TABLE "user" ADD COLUMN "banExpires" INTEGER` },
];

let _schemaReady: Promise<void> | null = null;

function ensureAdminColumns(): void {
  const existingCols = new Set(
    (getDb().prepare("PRAGMA table_info('user')").all() as { name: string }[]).map((c) => c.name),
  );
  for (const col of ADMIN_COLUMNS) {
    if (!existingCols.has(col.name)) {
      getDb().exec(col.ddl);
    }
  }
}

/** Run Better-Auth schema migrations idempotently (once per process). */
export function ensureAuthSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = auth.$context.then(async (ctx) => {
      try {
        await ctx.runMigrations();
      } catch {
        // runMigrations fails for SQLite (Kysely introspection not available).
        // Create tables and admin columns directly.
        for (const ddl of AUTH_TABLES_DDL) {
          getDb().exec(ddl);
        }
        ensureAdminColumns();
      }
    });
  }
  return _schemaReady;
}
