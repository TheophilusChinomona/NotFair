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

function resolveAuthSecret(): string {
  const fromEnv = process.env.BETTER_AUTH_SECRET;
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error("BETTER_AUTH_SECRET is required in production. Set it in the container environment (e.g. .env).");
  }
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

// Auth tables DDL — run BEFORE betterAuth() so the adapter sees the schema
// at initialization time, not after the fact. This avoids Kysely caching
// a schema-less state and then failing on subsequent queries.
const AUTH_DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
    "emailVerified" INTEGER NOT NULL DEFAULT 0, image TEXT,
    "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL,
    role TEXT DEFAULT 'user', banned INTEGER DEFAULT 0,
    "banReason" TEXT, "banExpires" INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS "session" (
    id TEXT PRIMARY KEY, "expiresAt" TEXT NOT NULL, token TEXT NOT NULL UNIQUE,
    "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL,
    "ipAddress" TEXT, "userAgent" TEXT,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE
  )`,
  `CREATE TABLE IF NOT EXISTS "account" (
    id TEXT PRIMARY KEY, "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
    "accessToken" TEXT, "refreshToken" TEXT, "idToken" TEXT,
    "expiresAt" TEXT, "password" TEXT,
    "createdAt" TEXT NOT NULL, "updatedAt" TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS "verification" (
    id TEXT PRIMARY KEY, identifier TEXT NOT NULL, value TEXT NOT NULL,
    "expiresAt" TEXT NOT NULL, "createdAt" TEXT, "updatedAt" TEXT
  )`,
];

function ensureTables(db: Database.Database): void {
  for (const ddl of AUTH_DDL) {
    try { db.exec(ddl); } catch { /* table may already exist */ }
  }
}

// Create database, initialize tables, then pass directly to betterAuth.
let db: Pool | Database.Database;
if (isPostgres) {
  db = new Pool({ connectionString: dbUrl! });
} else {
  if (!existsSync(DEFAULT_DATA_DIR)) {
    mkdirSync(DEFAULT_DATA_DIR, { recursive: true, mode: 0o700 });
  }
  const sqliteDb = new Database(DB_PATH);
  sqliteDb.pragma("journal_mode = WAL");
  sqliteDb.pragma("foreign_keys = ON");
  sqliteDb.pragma("busy_timeout = 5000");
  ensureTables(sqliteDb);
  db = sqliteDb;
}

export const auth = betterAuth({
  database: db,
  emailAndPassword: { enabled: true },
  secret: resolveAuthSecret(),
  baseURL: process.env.BETTER_AUTH_URL,
  trustedOrigins: [
    "http://localhost:3326",
    ...(process.env.BETTER_AUTH_URL ? [process.env.BETTER_AUTH_URL] : []),
  ],
  plugins: [admin()],
} satisfies BetterAuthOptions);

export function ensureAuthSchema(): Promise<void> {
  return auth.$context.then(() => {});
}
