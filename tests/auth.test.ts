import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { hashPassword, verifyPassword } from "../src/auth/password.js";
import { tokenHash } from "../src/auth/routes.js";
import {
  MemoryStore,
  fakeDatabase,
  headers,
  sessionCookie,
} from "./helpers.js";

const password = "This is a test password 2026!";
const hash = await hashPassword(password);
const config = loadConfig({ NODE_ENV: "test" });
async function fixture(production = false) {
  const store = new MemoryStore();
  store.admins.set("admin@example.test", {
    id: randomUUID(),
    name: "Test Admin",
    email: "admin@example.test",
    passwordHash: hash,
    role: "admin",
    status: "active",
  });
  const cfg = production
    ? loadConfig({
        NODE_ENV: "production",
        DB_ENABLED: "true",
        MYSQL_USER: "test",
        MYSQL_PASSWORD: "test-only",
        ADMIN_ORIGINS: "https://admin.example.test",
      })
    : config;
  const app = await buildApp(cfg, { authStore: store, database: fakeDatabase });
  const login = (extra: Record<string, string> = {}) =>
    app.inject({
      method: "POST",
      url: "/api/admin/auth/login",
      headers: { ...headers, ...extra },
      payload: { email: "ADMIN@example.test", password },
    });
  return { store, app, login };
}
test("password hashing uses unique salts and rejects incorrect passwords", async () => {
  const second = await hashPassword(password);
  assert.notEqual(second, hash);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword("incorrect", hash), false);
  assert.equal(await verifyPassword(password, "plain-text"), false);
});
test("login persists only a hashed token; me returns only public admin fields; logout revokes it", async () => {
  const { store, app, login } = await fixture();
  try {
    const response = await login();
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().data.admin.email, "admin@example.test");
    assert.deepEqual(Object.keys(response.json().data.admin).sort(), [
      "email",
      "id",
      "name",
      "role",
    ]);
    const cookie = sessionCookie(response.headers["set-cookie"]);
    assert.match(String(response.headers["set-cookie"]), /HttpOnly/);
    assert.match(String(response.headers["set-cookie"]), /SameSite=Lax/);
    assert.equal(response.headers["cache-control"], "no-store");
    const raw = cookie.split("=")[1]!;
    assert.equal(store.sessions.has(raw), false);
    assert.equal(store.sessions.has(tokenHash(raw)), true);
    assert.equal(
      (await app.inject({ url: "/api/admin/auth/me", headers: { cookie } }))
        .statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/auth/logout",
          headers: { ...headers, cookie },
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ url: "/api/admin/auth/me", headers: { cookie } }))
        .statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
test("unknown, wrong-password, and disabled administrators have the same error", async () => {
  const { store, app } = await fixture();
  try {
    const attempt = (email: string, pass: string) =>
      app.inject({
        method: "POST",
        url: "/api/admin/auth/login",
        headers,
        payload: { email, password: pass },
      });
    const unknown = await attempt("missing@example.test", password);
    const wrong = await attempt("admin@example.test", "incorrect");
    store.admins.get("admin@example.test")!.status = "disabled";
    const disabled = await attempt("admin@example.test", password);
    for (const result of [unknown, wrong, disabled]) {
      assert.equal(result.statusCode, 401);
      assert.deepEqual(result.json().error, unknown.json().error);
      assert.equal(result.headers["set-cookie"], undefined);
    }
  } finally {
    await app.close();
  }
});
test("CSRF checks reject missing origin, foreign origin, and missing custom header", async () => {
  const { app } = await fixture();
  try {
    for (const invalid of [
      {},
      {
        origin: "https://evil.example",
        "x-requested-with": "choicestakes-admin",
      },
      { origin: headers.origin },
      { ...headers, "sec-fetch-site": "cross-site" },
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/api/admin/auth/login",
        headers: invalid,
        payload: { email: "admin@example.test", password },
      });
      assert.equal(res.statusCode, 403);
    }
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/auth/logout",
          payload: {},
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
  }
});
test("player, fabricated, absent, expired, and idle session cookies cannot authenticate", async () => {
  const { app, store, login } = await fixture();
  try {
    for (const cookie of [
      "",
      "choicestakes_session=" + "a".repeat(43),
      "choicestakes_admin=" + "b".repeat(43),
    ]) {
      assert.equal(
        (await app.inject({ url: "/api/admin/auth/me", headers: { cookie } }))
          .statusCode,
        401,
      );
    }
    for (const kind of ["expiresAt", "lastSeenAt"] as const) {
      const cookie = sessionCookie((await login()).headers["set-cookie"]);
      const key = tokenHash(cookie.split("=")[1]!);
      store.sessions.get(key)![kind] = new Date(Date.now() - 9 * 3600000);
      assert.equal(
        (await app.inject({ url: "/api/admin/auth/me", headers: { cookie } }))
          .statusCode,
        401,
      );
    }
  } finally {
    await app.close();
  }
});
test("login rotates the previous session and disabling an admin blocks an active session", async () => {
  const { app, store, login } = await fixture();
  try {
    const old = sessionCookie((await login()).headers["set-cookie"]);
    const fresh = sessionCookie(
      (await login({ cookie: old })).headers["set-cookie"],
    );
    assert.notEqual(old, fresh);
    assert.equal(
      (
        await app.inject({
          url: "/api/admin/auth/me",
          headers: { cookie: old },
        })
      ).statusCode,
      401,
    );
    store.admins.get("admin@example.test")!.status = "disabled";
    assert.equal(
      (
        await app.inject({
          url: "/api/admin/auth/me",
          headers: { cookie: fresh },
        })
      ).statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
test("persistent account throttle blocks after ten attempts, including case variations", async () => {
  const { app, store } = await fixture();
  try {
    store.attempts.set("admin@example.test", 10);
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/auth/login",
      headers,
      payload: { email: "ADMIN@example.test", password },
    });
    assert.equal(res.statusCode, 429);
    assert.equal(res.headers["retry-after"], "900");
  } finally {
    await app.close();
  }
});
test("production cookies use a host-only Secure HttpOnly cookie", async () => {
  const { app, login } = await fixture(true);
  try {
    const res = await login({ origin: "https://admin.example.test" });
    assert.equal(res.statusCode, 200);
    assert.match(
      String(res.headers["set-cookie"]),
      /^__Host-choicestakes_admin=/,
    );
    for (const flag of ["Secure", "HttpOnly", "Path=/", "SameSite=Lax"])
      assert.ok(String(res.headers["set-cookie"]).includes(flag));
    assert.doesNotMatch(String(res.headers["set-cookie"]), /Domain=/i);
  } finally {
    await app.close();
  }
});
test("public registration does not exist and invalid payloads do not create sessions", async () => {
  const { app, store } = await fixture();
  try {
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/admin/auth/register",
          headers,
          payload: {},
        })
      ).statusCode,
      404,
    );
    for (const payload of [
      { email: "invalid", password },
      { email: "admin@example.test", password, role: "admin" },
      { email: "admin@example.test", password: "x".repeat(129) },
    ]) {
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/api/admin/auth/login",
            headers,
            payload,
          })
        ).statusCode,
        400,
      );
    }
    assert.equal(store.sessions.size, 0);
  } finally {
    await app.close();
  }
});
test("unconfigured database fails closed with a helpful safe error", async () => {
  const app = await buildApp(config);
  try {
    assert.equal((await app.inject({ url: "/health/ready" })).statusCode, 503);
    const res = await app.inject({
      method: "POST",
      url: "/api/admin/auth/login",
      headers,
      payload: { email: "admin@example.test", password },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json().error.code, "AUTH_UNAVAILABLE");
  } finally {
    await app.close();
  }
});
test("production environment rejects insecure or missing configuration", () => {
  assert.throws(() => loadConfig({ NODE_ENV: "production" }));
  assert.throws(() =>
    loadConfig({ ADMIN_ORIGINS: "https://admin.example.test/path" }),
  );
  assert.throws(() => loadConfig({ MYSQL_SSL_CA: "certificate.pem" }));
});
