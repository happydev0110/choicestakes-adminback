import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import { loadConfig } from "../src/config/env.js";
import { createDatabase, type Database } from "../src/database/mysql.js";
import { migrate } from "../src/database/migrate.js";
import { createManagementStore } from "../src/management/store.js";
import { playerFilters, gameFilters } from "../src/management/schemas.js";

test("MySQL management: real records, session revocation, visibility after sync, conflicts, and atomic audit", async () => {
  const target = process.env.MYSQL_TEST_DATABASE;
  assert.ok(
    target?.endsWith("_test"),
    "Set MYSQL_TEST_DATABASE to an existing disposable database ending in _test.",
  );
  const currency = "QA" + randomUUID().replaceAll("-", "").slice(0, 10);
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    DB_ENABLED: "true",
    MYSQL_DATABASE: target,
    APIMATIC_CURRENCY: currency,
  });
  const database = createDatabase(config),
    store = createManagementStore(database, config);
  const playerId = randomUUID(),
    gameId = randomUUID(),
    actorId = randomUUID(),
    email = playerId + "@management.invalid";
  const name = "QA " + playerId.slice(0, 8);
  try {
    // Use the real platform schema in this explicitly selected disposable database.
    const { migrations } = await import(
      new URL(
        "../../choicestakes-backend/src/database/migrations.ts",
        import.meta.url,
      ).href
    );
    await database.withConnection(async (connection) => {
      for (const migration of migrations)
        for (const sql of migration.statements) await connection.query(sql);
    });
    await migrate(database);
    await database.withConnection(async (connection) => {
      await connection.execute(
        "INSERT INTO players (id,email,display_name,password_hash,terms_version,terms_accepted_at,adult_confirmed_at) VALUES (?,?,?,'unused','test',UTC_TIMESTAMP(3),UTC_TIMESTAMP(3))",
        [playerId, email, name],
      );
      await connection.execute(
        "INSERT INTO player_sessions (token_hash,player_id,created_at,last_seen_at,expires_at) VALUES (?,?,UTC_TIMESTAMP(3),UTC_TIMESTAMP(3),DATE_ADD(UTC_TIMESTAMP(3),INTERVAL 1 HOUR))",
        [randomUUID().replaceAll("-", "").repeat(2), playerId],
      );
      await connection.execute(
        "INSERT INTO apimatic_games (currency,game_uuid,code,name,provider,vendor,available,sync_generation,synced_at) VALUES (?,?,'test-code','QA %_ game','QA studio','QA vendor',TRUE,?,UTC_TIMESTAMP(3))",
        [currency, gameId, randomUUID()],
      );
    });
    assert.equal(
      (await store.players(playerFilters.parse({ search: email }))).items[0]
        ?.id,
      playerId,
    );
    assert.equal((await store.player(playerId))?.activeSessions, 1);
    await store.updatePlayer(
      playerId,
      {
        displayName: name + " edited",
        status: "suspended",
        expected: { displayName: name, status: "active" },
      },
      actorId,
    );
    assert.equal((await store.player(playerId))?.status, "suspended");
    await database.withConnection(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        "SELECT COUNT(*) AS total FROM player_sessions WHERE player_id=?",
        [playerId],
      );
      assert.equal(Number(rows[0]?.total), 0);
    });
    await assert.rejects(
      store.updatePlayer(
        playerId,
        {
          displayName: name,
          status: "active",
          expected: { displayName: name, status: "active" },
        },
        actorId,
      ),
      { code: "EDIT_CONFLICT" },
    );
    assert.equal(
      (await store.games(gameFilters.parse({ search: "%_" }))).total,
      1,
    );
    assert.equal(
      (await store.games(gameFilters.parse({ search: "missing" }))).total,
      0,
    );
    await store.updateGame(
      gameId,
      {
        visible: false,
        categories: ["slots", "featured"],
        expected: { visible: true, categories: [] },
      },
      actorId,
    );
    assert.equal(
      (
        await store.games(
          gameFilters.parse({ visibility: "hidden", category: "slots" }),
        )
      ).total,
      1,
    );
    assert.equal(
      (await store.games(gameFilters.parse({ visibility: "visible" }))).total,
      0,
    );
    const { createGamingStore } = await import(
      new URL(
        "../../choicestakes-backend/src/modules/gaming/store.ts",
        import.meta.url,
      ).href
    );
    const { loadConfig: portalConfig } = await import(
      new URL("../../choicestakes-backend/src/config/env.ts", import.meta.url)
        .href
    );
    const gaming = createGamingStore(
      database,
      portalConfig({
        ...process.env,
        NODE_ENV: "test",
        DB_ENABLED: "true",
        MYSQL_DATABASE: target,
        APIMATIC_CURRENCY: currency,
        APIMATIC_ENABLED: "false",
      }),
    );
    await gaming.sync(async () => [
      {
        uuid: gameId,
        code: "test-code",
        name: "Provider renamed game",
        provider: "QA studio",
        vendor: "QA vendor",
      },
    ]);
    assert.equal(await gaming.game(gameId), null);
    assert.equal((await gaming.catalog(1, "", "")).total, 0);
    assert.equal((await store.game(gameId))?.name, "Provider renamed game");
    assert.deepEqual((await store.game(gameId))?.categories, [
      "featured",
      "slots",
    ]);
    await assert.rejects(
      store.updateGame(
        gameId,
        {
          visible: true,
          categories: [],
          expected: { visible: true, categories: [] },
        },
        actorId,
      ),
      { code: "EDIT_CONFLICT" },
    );
    // Audit failure must roll back the settings/category changes as one transaction.
    const failAuditDatabase: Database = {
      ...database,
      transaction: (work) =>
        database.transaction((connection) =>
          work(
            new Proxy(connection, {
              get(target, key) {
                if (key === "execute")
                  return (sql: string, values: unknown[]) => {
                    if (sql.includes("INSERT INTO admin_audit_log"))
                      throw new Error("Simulated audit failure");
                      return Reflect.apply(target.execute, target, [sql, values]);
                  };
                const value = Reflect.get(target, key);
                return typeof value === "function" ? value.bind(target) : value;
              },
            }),
          ),
        ),
    };
    await assert.rejects(
      createManagementStore(failAuditDatabase, config).updateGame(
        gameId,
        {
          visible: true,
          categories: ["live"],
          expected: { visible: false, categories: ["featured", "slots"] },
        },
        actorId,
      ),
      { code: "MANAGEMENT_UNAVAILABLE" },
    );
    assert.equal((await store.game(gameId))?.visible, false);
    assert.deepEqual((await store.game(gameId))?.categories, [
      "featured",
      "slots",
    ]);
    const outcomes = await Promise.allSettled([
      store.updateGame(
        gameId,
        {
          visible: true,
          categories: ["slots"],
          expected: { visible: false, categories: ["featured", "slots"] },
        },
        actorId,
      ),
      store.updateGame(
        gameId,
        {
          visible: true,
          categories: ["live"],
          expected: { visible: false, categories: ["featured", "slots"] },
        },
        actorId,
      ),
    ]);
    assert.equal(
      outcomes.filter((outcome) => outcome.status === "fulfilled").length,
      1,
    );
    assert.equal((await gaming.catalog(1, "", "")).total, 1);
    await database.withConnection(async (connection) => {
      const [rows] = await connection.execute<RowDataPacket[]>(
        "SELECT action,admin_id,before_json,after_json FROM admin_audit_log WHERE target_id IN (?,?)",
        [playerId, gameId],
      );
      assert.equal(rows.length, 3);
      assert.ok(rows.every((row) => row.admin_id === actorId));
    });
  } finally {
    try {
      await database.withConnection(async (connection) => {
        await connection.execute(
          "DELETE FROM admin_audit_log WHERE target_id IN (?,?)",
          [playerId, gameId],
        );
        await connection.execute(
          "DELETE FROM player_sessions WHERE player_id=?",
          [playerId],
        );
        await connection.execute("DELETE FROM players WHERE id=?", [playerId]);
        await connection.execute(
          "DELETE FROM apimatic_games WHERE currency=?",
          [currency],
        );
        await connection.execute(
          "DELETE FROM apimatic_catalog_sync WHERE currency=?",
          [currency],
        );
      });
    } finally {
      await database.close();
    }
  }
});
