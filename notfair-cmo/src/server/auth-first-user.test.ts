import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";

/**
 * Minimal auth-schema DDL matching what better-auth 1.6.22 creates
 * via its built-in adapter (including admin-plugin columns).
 */
const AUTH_SCHEMA_SQL = [
  `CREATE TABLE IF NOT EXISTS "user" (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    "emailVerified" INTEGER NOT NULL,
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

type CountRow = { n: number };

describe("first-user-only", () => {
  it("first sign-up creates admin, second is rejected", async () => {
    const db = new Database(":memory:");
    for (const sql of AUTH_SCHEMA_SQL) db.exec(sql);

    // Simulate the databaseHooks.user.create.before logic
    async function beforeHook(
      user: Record<string, unknown>,
    ): Promise<false | { data: Record<string, unknown> }> {
      const raw = db.prepare('SELECT COUNT(*) AS n FROM "user"').get();
      if (raw && typeof raw === "object" && "n" in raw) {
        const countRow = raw as CountRow;
        if (countRow.n > 0) return false;
      }
      return { data: { ...user, role: "admin" } };
    }

    // First user — hook promotes to admin
    const result1 = await beforeHook({
      email: "a@a.com",
      name: "A",
    });
    expect(result1).not.toBe(false);

    const result1Val = result1 as { data: Record<string, unknown> };
    expect(result1Val.data.role).toBe("admin");

    // Insert first user
    db.prepare(
      'INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", role) VALUES (?, ?, ?, 1, ?, ?, ?)',
    ).run("1", "A", "a@a.com", new Date().toISOString(), new Date().toISOString(), "admin");

    // Verify count = 1
    const countRaw1 = db.prepare('SELECT COUNT(*) AS n FROM "user"').get();
    expect(countRaw1).not.toBeNull();
    const countRow1 = countRaw1 as CountRow;
    expect(countRow1.n).toBe(1);

    // Verify user row has admin role
    const userRaw = db.prepare('SELECT * FROM "user" WHERE email = ?').get("a@a.com");
    expect(userRaw).not.toBeNull();
    const user = userRaw as Record<string, unknown>;
    expect(user.role).toBe("admin");

    // Second user — hook blocks registration
    const result2 = await beforeHook({
      email: "b@b.com",
      name: "B",
    });
    expect(result2).toBe(false);

    // Count still 1
    const countRaw2 = db.prepare('SELECT COUNT(*) AS n FROM "user"').get();
    const countRow2 = countRaw2 as CountRow;
    expect(countRow2.n).toBe(1);

    db.close();
  });

  it("admin columns exist after schema creation", () => {
    const db = new Database(":memory:");
    for (const sql of AUTH_SCHEMA_SQL) db.exec(sql);

    const userColsRaw = db.prepare("PRAGMA table_info('user')").all() as {
      name: string;
    }[];
    const colNames = userColsRaw.map((c) => c.name);
    expect(colNames).toContain("role");
    expect(colNames).toContain("banned");
    expect(colNames).toContain("banReason");
    expect(colNames).toContain("banExpires");

    const tablesRaw = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as { name: string }[];
    const tables = tablesRaw.map((r) => r.name);
    expect(tables).toContain("user");
    expect(tables).toContain("session");
    expect(tables).toContain("account");
    expect(tables).toContain("verification");

    db.close();
  });
});
