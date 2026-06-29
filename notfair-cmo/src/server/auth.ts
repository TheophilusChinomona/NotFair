import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { betterAuth } from "better-auth";
import Database from "better-sqlite3";
import { Pool } from "pg";

const DEFAULT_DATA_DIR = process.env.NOTFAIR_CMO_DATA_DIR ?? join(homedir(), ".notfair-cmo");
const DB_PATH = join(DEFAULT_DATA_DIR, "db.sqlite");

const dbUrl = process.env.DATABASE_URL;
const isPostgres = dbUrl && (dbUrl.startsWith("postgres://") || dbUrl.startsWith("postgresql://"));

let databaseConfig: any;

if (isPostgres) {
  databaseConfig = {
    db: new Pool({ connectionString: dbUrl }),
    type: "postgres"
  };
} else {
  if (!existsSync(DEFAULT_DATA_DIR)) {
    mkdirSync(DEFAULT_DATA_DIR, { recursive: true, mode: 0o700 });
  }
  databaseConfig = {
    db: new Database(DB_PATH),
    type: "sqlite"
  };
}

export const auth = betterAuth({
  database: databaseConfig,
  emailAndPassword: {
    enabled: true,
  },
  secret: process.env.BETTER_AUTH_SECRET || "default_super_secret_for_local_dev_12345",
  trustedOrigins: [
    "http://localhost:3326",
    process.env.BETTER_AUTH_URL || "http://localhost:3326"
  ]
});
