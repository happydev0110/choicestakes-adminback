import { randomUUID } from "node:crypto";
import type { RowDataPacket, PoolConnection } from "mysql2/promise";
import type { Database } from "../database/mysql.js";
import type { Config } from "../config/env.js";
import { AuthError } from "../auth/types.js";
import { categories } from "./schemas.js";
import type { Game, Player, ManagementStore } from "./types.js";

const perPage = 25;
const playerColumns =
  "id,email,display_name,status,email_verified_at,created_at";
function date(value: unknown) {
  return String(value).replace(" ", "T") + "Z";
}
function player(row: RowDataPacket): Player {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    status: row.status,
    emailVerified: row.email_verified_at !== null,
    createdAt: date(row.created_at),
  };
}
function artwork(value: unknown): string | null {
  try {
    const url = new URL(String(value));
    return url.protocol === "https:" &&
      url.hostname === "static.api-matic.com" &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
function game(row: RowDataPacket): Game {
  return {
    uuid: row.game_uuid,
    name: row.name,
    provider: row.provider,
    vendor: row.vendor,
    code: row.code,
    currency: row.currency,
    imageUrl: artwork(row.image_url),
    available: Boolean(Number(row.available)),
    visible: Boolean(Number(row.visible)),
    categories: [],
    syncedAt: date(row.synced_at),
  };
}
const gameColumns =
  "g.game_uuid,g.name,g.provider,g.vendor,g.code,g.currency,g.image_url,g.available,g.synced_at,COALESCE(v.visible,TRUE) AS visible";
const gameJoin =
  "apimatic_games g LEFT JOIN apimatic_game_settings v ON v.currency=g.currency AND v.game_uuid=g.game_uuid";
function pattern(value: string) {
  return "%" + value.replace(/[=%_]/g, "=$&") + "%";
}
const sorted = (values: readonly string[]) => [...values].sort();
async function audit(
  connection: PoolConnection,
  actorId: string,
  action: string,
  target: string,
  currency: string | null,
  before: unknown,
  after: unknown,
) {
  await connection.execute(
    "INSERT INTO admin_audit_log (id,admin_id,action,target_id,currency,before_json,after_json) VALUES (?,?,?,?,?,?,?)",
    [
      randomUUID(),
      actorId,
      action,
      target,
      currency,
      JSON.stringify(before),
      JSON.stringify(after),
    ],
  );
}
async function attachCategories(
  connection: PoolConnection,
  games: Game[],
  currency: string,
) {
  if (!games.length) return;
  const [rows] = await connection.execute<RowDataPacket[]>(
    `SELECT game_uuid,category FROM apimatic_game_categories WHERE currency=? AND game_uuid IN (${games.map(() => "?").join(",")}) ORDER BY category`,
    [currency, ...games.map((g) => g.uuid)],
  );
  for (const item of games)
    item.categories = rows
      .filter((row) => row.game_uuid === item.uuid)
      .map((row) => String(row.category));
}
export function createManagementStore(
  database: Database,
  config: Config,
): ManagementStore {
  async function ready<T>(fn: () => Promise<T>): Promise<T> {
    if (!database.enabled)
      throw new AuthError(
        503,
        "MANAGEMENT_UNAVAILABLE",
        "Configure the admin database to manage platform data.",
      );
    try {
      return await fn();
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        503,
        "MANAGEMENT_UNAVAILABLE",
        "Platform data is unavailable. Check the shared database connection and run both backend migrations.",
      );
    }
  }
  const store: ManagementStore = {
    players(filters) {
      return ready(() =>
        database.withConnection(async (connection) => {
          const where =
            "(email LIKE ? ESCAPE '=' OR display_name LIKE ? ESCAPE '=' OR id=?) AND (?='' OR status=?)";
          const params = [
            pattern(filters.search),
            pattern(filters.search),
            filters.search,
            filters.status,
            filters.status,
          ];
          const [counts] = await connection.execute<RowDataPacket[]>(
            `SELECT COUNT(*) AS total FROM players WHERE ${where}`,
            params,
          );
          const total = Number(counts[0]?.total ?? 0),
            page = Math.min(
              filters.page,
              Math.max(1, Math.ceil(total / perPage)),
            );
          const [rows] = await connection.query<RowDataPacket[]>(
            `SELECT ${playerColumns} FROM players WHERE ${where} ORDER BY created_at DESC,id LIMIT ? OFFSET ?`,
            [...params, perPage, (page - 1) * perPage],
          );
          return { items: rows.map(player), total, page, perPage };
        }),
      );
    },
    player(id) {
      return ready(() =>
        database.withConnection(async (connection) => {
          const [rows] = await connection.execute<RowDataPacket[]>(
            `SELECT ${playerColumns} FROM players WHERE id=?`,
            [id],
          );
          if (!rows[0]) return null;
          // Player sessions use the portal backend's configured idle window.
          const [counts] = await connection.execute<RowDataPacket[]>(
            "SELECT COUNT(*) AS total FROM player_sessions WHERE player_id=? AND expires_at>UTC_TIMESTAMP(3) AND last_seen_at>DATE_SUB(UTC_TIMESTAMP(3),INTERVAL ? MINUTE)",
            [id, config.PLAYER_SESSION_IDLE_MINUTES],
          );
          return {
            ...player(rows[0]),
            activeSessions:
              rows[0].status === "active" ? Number(counts[0]?.total ?? 0) : 0,
          };
        }),
      );
    },
    updatePlayer(id, input, actorId) {
      return ready(() =>
        database.transaction(async (connection) => {
          const [rows] = await connection.execute<RowDataPacket[]>(
            "SELECT id,display_name,status FROM players WHERE id=? FOR UPDATE",
            [id],
          );
          const row = rows[0];
          if (!row)
            throw new AuthError(404, "PLAYER_NOT_FOUND", "Player not found.");
          if (!["active", "suspended"].includes(row.status))
            throw new AuthError(
              409,
              "RESTRICTED_STATUS",
              "This account has a restricted status and cannot be changed here.",
            );
          if (
            row.display_name !== input.expected.displayName ||
            row.status !== input.expected.status
          )
            throw new AuthError(
              409,
              "EDIT_CONFLICT",
              "This player changed while you were editing. Close the editor, refresh, and try again.",
            );
          const before = { displayName: row.display_name, status: row.status };
          const after = {
            displayName: input.displayName,
            status: input.status,
          };
          if (JSON.stringify(before) === JSON.stringify(after)) return;
          await connection.execute(
            "UPDATE players SET display_name=?,status=? WHERE id=?",
            [input.displayName, input.status, id],
          );
          if (input.status === "suspended")
            await connection.execute(
              "DELETE FROM player_sessions WHERE player_id=?",
              [id],
            );
          await audit(
            connection,
            actorId,
            "player.update",
            id,
            null,
            before,
            after,
          );
        }),
      );
    },
    games(filters) {
      return ready(() =>
        database.withConnection(async (connection) => {
          let where =
            "g.currency=? AND (g.name LIKE ? ESCAPE '=' OR g.game_uuid=?) AND (?='' OR g.provider=?)";
          const params: (string | number)[] = [
            config.APIMATIC_CURRENCY,
            pattern(filters.search),
            filters.search,
            filters.provider,
            filters.provider,
          ];
          if (filters.availability) {
            where += " AND g.available=?";
            params.push(filters.availability === "available" ? 1 : 0);
          }
          if (filters.visibility) {
            where += " AND COALESCE(v.visible,TRUE)=?";
            params.push(filters.visibility === "visible" ? 1 : 0);
          }
          if (filters.category) {
            where +=
              " AND EXISTS (SELECT 1 FROM apimatic_game_categories c WHERE c.currency=g.currency AND c.game_uuid=g.game_uuid AND c.category=?)";
            params.push(filters.category);
          }
          const [counts] = await connection.execute<RowDataPacket[]>(
            `SELECT COUNT(*) AS total FROM ${gameJoin} WHERE ${where}`,
            params,
          );
          const total = Number(counts[0]?.total ?? 0),
            page = Math.min(
              filters.page,
              Math.max(1, Math.ceil(total / perPage)),
            );
          const [rows] = await connection.query<RowDataPacket[]>(
            `SELECT ${gameColumns} FROM ${gameJoin} WHERE ${where} ORDER BY g.provider,g.name,g.game_uuid LIMIT ? OFFSET ?`,
            [...params, perPage, (page - 1) * perPage],
          );
          const items = rows.map(game);
          await attachCategories(connection, items, config.APIMATIC_CURRENCY);
          const [providers] = await connection.execute<RowDataPacket[]>(
            "SELECT DISTINCT provider FROM apimatic_games WHERE currency=? ORDER BY provider",
            [config.APIMATIC_CURRENCY],
          );
          const [sync] = await connection.execute<RowDataPacket[]>(
            "SELECT status,started_at,succeeded_at,provider_total,error_code FROM apimatic_catalog_sync WHERE environment='sandbox' AND currency=?",
            [config.APIMATIC_CURRENCY],
          );
          const state = sync[0];
          return {
            items,
            total,
            page,
            perPage,
            currency: config.APIMATIC_CURRENCY,
            providers: providers.map((row) => String(row.provider)),
            categories,
            sync: state
              ? {
                  status: state.status,
                  lastSuccessAt: state.succeeded_at
                    ? date(state.succeeded_at)
                    : null,
                  lastAttemptAt: state.started_at
                    ? date(state.started_at)
                    : null,
                  providerTotal:
                    state.provider_total == null
                      ? null
                      : Number(state.provider_total),
                  errorCode: state.error_code ?? null,
                }
              : null,
          };
        }),
      );
    },
    game(id) {
      return ready(() =>
        database.withConnection(async (connection) => {
          const [rows] = await connection.execute<RowDataPacket[]>(
            `SELECT ${gameColumns} FROM ${gameJoin} WHERE g.currency=? AND g.game_uuid=?`,
            [config.APIMATIC_CURRENCY, id],
          );
          if (!rows[0]) return null;
          const item = game(rows[0]);
          await attachCategories(connection, [item], config.APIMATIC_CURRENCY);
          return item;
        }),
      );
    },
    updateGame(id, input, actorId) {
      return ready(() =>
        database.transaction(async (connection) => {
          // Same game-row lock used by provider synchronization and the category CLI.
          const [rows] = await connection.execute<RowDataPacket[]>(
            "SELECT game_uuid FROM apimatic_games WHERE currency=? AND game_uuid=? FOR UPDATE",
            [config.APIMATIC_CURRENCY, id],
          );
          if (!rows[0])
            throw new AuthError(
              404,
              "GAME_NOT_FOUND",
              "Game not found in the configured currency.",
            );
          const [settings] = await connection.execute<RowDataPacket[]>(
            "SELECT visible FROM apimatic_game_settings WHERE currency=? AND game_uuid=?",
            [config.APIMATIC_CURRENCY, id],
          );
          const [assigned] = await connection.execute<RowDataPacket[]>(
            "SELECT category FROM apimatic_game_categories WHERE currency=? AND game_uuid=? ORDER BY category",
            [config.APIMATIC_CURRENCY, id],
          );
          const before = {
            visible: settings[0] ? Boolean(Number(settings[0].visible)) : true,
            categories: sorted(assigned.map((row) => String(row.category))),
          };
          if (
            before.visible !== input.expected.visible ||
            JSON.stringify(before.categories) !==
              JSON.stringify(sorted(input.expected.categories))
          )
            throw new AuthError(
              409,
              "EDIT_CONFLICT",
              "This game changed while you were editing. Close the editor, refresh, and try again.",
            );
          const after = {
            visible: input.visible,
            categories: sorted(input.categories),
          };
          if (JSON.stringify(before) === JSON.stringify(after)) return;
          await connection.execute(
            "INSERT INTO apimatic_game_settings (currency,game_uuid,visible) VALUES (?,?,?) ON DUPLICATE KEY UPDATE visible=VALUES(visible),updated_at=UTC_TIMESTAMP(3)",
            [config.APIMATIC_CURRENCY, id, input.visible],
          );
          await connection.execute(
            "DELETE FROM apimatic_game_categories WHERE currency=? AND game_uuid=?",
            [config.APIMATIC_CURRENCY, id],
          );
          for (const category of after.categories)
            await connection.execute(
              "INSERT INTO apimatic_game_categories (currency,game_uuid,category) VALUES (?,?,?)",
              [config.APIMATIC_CURRENCY, id, category],
            );
          await audit(
            connection,
            actorId,
            "game.update",
            id,
            config.APIMATIC_CURRENCY,
            before,
            after,
          );
        }),
      );
    },
  };
  return store;
}
