import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config/env.js";
import { tokenHash } from "../src/auth/routes.js";
import { AuthError } from "../src/auth/types.js";
import { MemoryStore, fakeDatabase, headers } from "./helpers.js";
import { createManagementStore } from "../src/management/store.js";
import {
  playerFilters,
  gameFilters,
  playerUpdate,
  gameUpdate,
} from "../src/management/schemas.js";
import type { Database } from "../src/database/mysql.js";
import type {
  ManagementStore,
  PlayerDetails,
  Game,
} from "../src/management/types.js";

const player: PlayerDetails = {
  id: randomUUID(),
  email: "player@example.test",
  displayName: "Sample Player",
  status: "active",
  emailVerified: false,
  createdAt: "2026-01-01T00:00:00Z",
  activeSessions: 1,
};
const game: Game = {
  uuid: randomUUID(),
  currency: "USD",
  name: "Test game",
  code: "test-game",
  provider: "Test Studio",
  vendor: "Test Vendor",
  imageUrl: null,
  available: true,
  visible: true,
  categories: [],
  syncedAt: "2026-01-01T00:00:00Z",
};
async function fixture() {
  const auth = new MemoryStore();
  const adminId = randomUUID(),
    token = "a".repeat(43);
  auth.admins.set("admin@example.test", {
    id: adminId,
    name: "Admin",
    email: "admin@example.test",
    role: "admin",
    status: "active",
    passwordHash: "unused",
  });
  auth.sessions.set(tokenHash(token), {
    adminId,
    tokenHash: tokenHash(token),
    createdAt: new Date(),
    lastSeenAt: new Date(),
    expiresAt: new Date(Date.now() + 3600000),
  });
  const writes: unknown[] = [];
  const store: ManagementStore = {
    async players(filters) {
      return {
        items: filters.search === "missing" ? [] : [player],
        total: filters.search === "missing" ? 0 : 1,
        page: 1,
        perPage: 25,
      };
    },
    async player(id) {
      return id === player.id ? player : null;
    },
    async updatePlayer(id, input, actorId) {
      writes.push({ id, input, actorId });
    },
    async games() {
      return {
        items: [game],
        total: 1,
        page: 1,
        perPage: 25,
        currency: "USD",
        providers: ["Test Studio"],
        categories: ["slots"],
        sync: null,
      };
    },
    async game(id) {
      return id === game.uuid ? game : null;
    },
    async updateGame(id, input, actorId) {
      writes.push({ id, input, actorId });
    },
  };
  const app = await buildApp(loadConfig({ NODE_ENV: "test" }), {
    database: fakeDatabase,
    authStore: auth,
    managementStore: store,
  });
  return {
    app,
    store,
    auth,
    adminId,
    writes,
    authenticated: { ...headers, cookie: "choicestakes_admin=" + token },
  };
}
test("every management read and write requires an active administrator", async () => {
  const { app, authenticated, auth } = await fixture();
  try {
    for (const path of [
      "/players",
      "/players/" + player.id,
      "/games",
      "/games/" + game.uuid,
    ]) {
      assert.equal(
        (await app.inject({ url: "/api/admin" + path })).statusCode,
        401,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/admin/players/" + player.id,
          headers,
          payload: {},
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/admin/games/" + game.uuid,
          headers,
          payload: {},
        })
      ).statusCode,
      401,
    );
    auth.admins.get("admin@example.test")!.status = "disabled";
    assert.equal(
      (await app.inject({ url: "/api/admin/players", headers: authenticated }))
        .statusCode,
      401,
    );
  } finally {
    await app.close();
  }
});
test("management reads, empty filters, and missing IDs have explicit responses", async () => {
  const { app, authenticated } = await fixture();
  try {
    for (const path of [
      "/players",
      "/players/" + player.id,
      "/games",
      "/games/" + game.uuid,
    ]) {
      const response = await app.inject({
        url: "/api/admin" + path,
        headers: authenticated,
      });
      assert.equal(response.statusCode, 200);
      assert.equal(response.headers["cache-control"], "no-store");
      assert.doesNotMatch(response.body, /passwordHash|tokenHash/);
    }
    const empty = await app.inject({
      url: "/api/admin/players?search=missing",
      headers: authenticated,
    });
    assert.equal(empty.json().data.total, 0);
    assert.equal(
      (
        await app.inject({
          url: "/api/admin/players/" + randomUUID(),
          headers: authenticated,
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await app.inject({
          url: "/api/admin/games/not-a-uuid",
          headers: authenticated,
        })
      ).statusCode,
      400,
    );
    for (const path of [
      "/players?page=-1",
      "/players?status=deleted",
      "/games?currency=EUR",
      "/games?category=invented",
      "/games?page=NaN",
    ])
      assert.equal(
        (await app.inject({ url: "/api/admin" + path, headers: authenticated }))
          .statusCode,
        400,
      );
  } finally {
    await app.close();
  }
});
test("CSRF and mass assignment guards reject unauthorized mutations", async () => {
  const { app, authenticated, writes } = await fixture();
  const payload = {
    displayName: "Updated",
    status: "suspended",
    expected: { displayName: player.displayName, status: player.status },
  };
  try {
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/admin/players/" + player.id,
          headers: { ...authenticated, origin: "https://evil.example" },
          payload,
        })
      ).statusCode,
      403,
    );
    for (const added of [
      { role: "admin" },
      { email: "new@example.test" },
      { balance: 100 },
      { password: "not-allowed" },
    ]) {
      assert.equal(
        (
          await app.inject({
            method: "PATCH",
            url: "/api/admin/players/" + player.id,
            headers: authenticated,
            payload: { ...payload, ...added },
          })
        ).statusCode,
        400,
      );
    }
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/admin/games/" + game.uuid,
          headers: authenticated,
          payload: {
            visible: false,
            categories: [],
            expected: { visible: true, categories: [] },
            available: true,
          },
        })
      ).statusCode,
      400,
    );
    assert.equal(writes.length, 0);
  } finally {
    await app.close();
  }
});
test("valid mutations are attributed to the session administrator", async () => {
  const { app, authenticated, writes, adminId } = await fixture();
  try {
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/admin/players/" + player.id,
          headers: authenticated,
          payload: {
            displayName: "Updated",
            status: "suspended",
            expected: { displayName: player.displayName, status: "active" },
          },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await app.inject({
          method: "PATCH",
          url: "/api/admin/games/" + game.uuid,
          headers: authenticated,
          payload: {
            visible: false,
            categories: ["slots", "featured"],
            expected: { visible: true, categories: [] },
          },
        })
      ).statusCode,
      200,
    );
    assert.equal(writes.length, 2);
    for (const write of writes)
      assert.equal((write as { actorId: string }).actorId, adminId);
  } finally {
    await app.close();
  }
});
test("edit conflicts and database failures remain errors, not success responses", async () => {
  const { app, authenticated, store } = await fixture();
  try {
    store.updateGame = async () => {
      throw new AuthError(409, "EDIT_CONFLICT", "Refresh this game.");
    };
    const result = await app.inject({
      method: "PATCH",
      url: "/api/admin/games/" + game.uuid,
      headers: authenticated,
      payload: {
        visible: false,
        categories: [],
        expected: { visible: true, categories: [] },
      },
    });
    assert.equal(result.statusCode, 409);
    store.players = async () => {
      throw new Error("password=should-not-leak");
    };
    const broken = await app.inject({
      url: "/api/admin/players",
      headers: authenticated,
    });
    assert.equal(broken.statusCode, 500);
    assert.doesNotMatch(broken.body, /should-not-leak/);
  } finally {
    await app.close();
  }
});
test("schema accepts reversible settings but rejects duplicate tags and restricted status values", () => {
  assert.equal(
    gameUpdate.safeParse({
      visible: true,
      categories: ["slots", "slots"],
      expected: { visible: true, categories: [] },
    }).success,
    false,
  );
  assert.equal(
    playerUpdate.safeParse({
      displayName: "A",
      status: "active",
      expected: { displayName: "Before", status: "active" },
    }).success,
    false,
  );
  assert.equal(gameFilters.parse({}).page, 1);
  assert.equal(playerFilters.parse({}).search, "");
});
test("database records are projected to public management fields with parameterized literal search", async () => {
  const calls: { sql: string; params: unknown }[] = [];
  const connection = {
    async execute(sql: string, params: unknown) {
      calls.push({ sql, params });
      return [[{ total: 1 }], []];
    },
    async query(sql: string, params: unknown) {
      calls.push({ sql, params });
      return [
        [
          {
            id: player.id,
            email: player.email,
            display_name: player.displayName,
            status: "active",
            email_verified_at: null,
            created_at: "2026-01-01 00:00:00.000",
            password_hash: "SECRET",
          },
        ],
        [],
      ];
    },
  };
  const database = {
    enabled: true,
    withConnection: async (fn: (c: typeof connection) => unknown) =>
      fn(connection),
  } as unknown as Database;
  const store = createManagementStore(
    database,
    loadConfig({ NODE_ENV: "test" }),
  );
  const result = await store.players(
    playerFilters.parse({ search: "%_=' OR 1=1" }),
  );
  assert.doesNotMatch(JSON.stringify(result), /SECRET|password_hash/);
  assert.ok(calls.every((call) => !call.sql.includes("OR 1=1")));
  assert.ok(JSON.stringify(calls[0]?.params).includes("=%=_=="));
});
