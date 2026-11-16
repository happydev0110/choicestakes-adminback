import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { loadConfig } from "../src/config/env.js";
import { createDatabase } from "../src/database/mysql.js";
import { migrate } from "../src/database/migrate.js";
import { buildApp } from "../src/app.js";
import { hashPassword } from "../src/auth/password.js";
import { headers, sessionCookie } from "./helpers.js";

test("MySQL migrations, durable sessions, expiry, throttling, and revocation", async () => {
  const target = process.env.MYSQL_TEST_DATABASE;
  assert.ok(
    target?.endsWith("_test"),
    "Set MYSQL_TEST_DATABASE to an existing disposable database ending in _test.",
  );
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DB_ENABLED: "true",
    MYSQL_DATABASE: target,
    ADMIN_ORIGINS: headers.origin,
  });
  const database = createDatabase(config);
  const id = randomUUID(),
    email = id + "@admin-test.invalid",
    password = randomBytes(24).toString("base64url");
  const passwordHash = await hashPassword(password);
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const attemptKey = createHash("sha256")
    .update("admin-login:" + email)
    .digest("hex");
  try {
    await migrate(database);
    await migrate(database);
    await database.withConnection((connection) =>
      connection.execute(
        "INSERT INTO admins (id,email,name,password_hash) VALUES (?,?,?,?)",
        [id, email, "Integration test", passwordHash],
      ),
    );
    const app = await buildApp(config);
    apps.push(app);
    const login = () =>
      app.inject({
        method: "POST",
        url: "/api/admin/auth/login",
        headers,
        payload: { email, password },
      });
    const first = await login();
    assert.equal(first.statusCode, 200);
    let cookie = sessionCookie(first.headers["set-cookie"]);
    await app.close();
    apps.pop();
    const restarted = await buildApp(config);
    apps.push(restarted);
    assert.equal(
      (
        await restarted.inject({
          url: "/api/admin/auth/me",
          headers: { cookie },
        })
      ).statusCode,
      200,
      "Session must survive an API restart",
    );
    await database.withConnection((connection) =>
      connection.execute(
        "UPDATE admin_sessions SET last_seen_at=DATE_SUB(UTC_TIMESTAMP(3),INTERVAL 2 HOUR) WHERE admin_id=?",
        [id],
      ),
    );
    assert.equal(
      (
        await restarted.inject({
          url: "/api/admin/auth/me",
          headers: { cookie },
        })
      ).statusCode,
      401,
      "Idle sessions expire",
    );
    const loginAgain = () =>
      restarted.inject({
        method: "POST",
        url: "/api/admin/auth/login",
        headers,
        payload: { email, password },
      });
    cookie = sessionCookie((await loginAgain()).headers["set-cookie"]);
    await database.withConnection((connection) =>
      connection.execute("UPDATE admins SET status='disabled' WHERE id=?", [
        id,
      ]),
    );
    assert.equal(
      (
        await restarted.inject({
          url: "/api/admin/auth/me",
          headers: { cookie },
        })
      ).statusCode,
      401,
      "Disabled admins lose access",
    );
    await database.withConnection((connection) =>
      connection.execute("UPDATE admins SET status='active' WHERE id=?", [id]),
    );
    cookie = sessionCookie((await loginAgain()).headers["set-cookie"]);
    assert.equal(
      (
        await restarted.inject({
          method: "POST",
          url: "/api/admin/auth/logout",
          headers: { ...headers, cookie },
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await restarted.inject({
          url: "/api/admin/auth/me",
          headers: { cookie },
        })
      ).statusCode,
      401,
      "Logout removes durable session",
    );
    await database.withConnection(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        "SELECT token_hash FROM admin_sessions WHERE admin_id=?",
        [id],
      );
      assert.equal(rows.length, 0);
      await connection.execute(
        "UPDATE admin_login_attempts SET attempts=10 WHERE attempt_key=?",
        [attemptKey],
      );
    });
    assert.equal(
      (await loginAgain()).statusCode,
      429,
      "Database throttle is enforced",
    );
    const { createAuthStore } = await import("../src/auth/store.js");
    const store = createAuthStore(database);
    await assert.rejects(
      store.createSession(
        {
          tokenHash: "a".repeat(64),
          adminId: id,
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 3600000),
        },
        "stale-password-hash",
      ),
    );
  } finally {
    for (const app of apps) await app.close();
    try {
      await database.withConnection(async (connection) => {
        await connection.execute("DELETE FROM admins WHERE id=?", [id]);
        await connection.execute(
          "DELETE FROM admin_login_attempts WHERE attempt_key=?",
          [attemptKey],
        );
      });
    } finally {
      await database.close();
    }
  }
});
