import { createHash } from "node:crypto";
import type { RowDataPacket } from "mysql2/promise";
import type { Database } from "../database/mysql.js";
import {
  AuthError,
  publicAdmin,
  type Admin,
  type AuthStore,
  type StoredAdmin,
} from "./types.js";

export function createAuthStore(database: Database): AuthStore {
  async function ready<T>(work: () => Promise<T>): Promise<T> {
    if (!database.enabled)
      throw new AuthError(
        503,
        "AUTH_UNAVAILABLE",
        "Admin sign-in is not configured yet.",
      );
    try {
      return await work();
    } catch (error) {
      if (error instanceof AuthError) throw error;
      throw new AuthError(
        503,
        "AUTH_UNAVAILABLE",
        "Admin sign-in is temporarily unavailable. Please try again later.",
      );
    }
  }
  return {
    findByEmail(email) {
      return ready(() =>
        database.withConnection(async (connection) => {
          const [rows] = await connection.execute<
            (RowDataPacket & StoredAdmin)[]
          >(
            "SELECT id,email,name,role,status,password_hash AS passwordHash FROM admins WHERE email=?",
            [email],
          );
          return rows[0] ?? null;
        }),
      );
    },
    consumeLoginAttempt(email) {
      const key = createHash("sha256")
        .update("admin-login:" + email)
        .digest("hex");
      const bucket = Math.floor(Date.now() / 900000);
      return ready(() =>
        database.transaction(async (connection) => {
          await connection.execute(
            `INSERT INTO admin_login_attempts (attempt_key,bucket,attempts) VALUES (?,?,1)
          ON DUPLICATE KEY UPDATE attempts=IF(bucket=VALUES(bucket),LEAST(attempts+1,100000),1),bucket=VALUES(bucket)`,
            [key, bucket],
          );
          const [rows] = await connection.execute<RowDataPacket[]>(
            "SELECT attempts FROM admin_login_attempts WHERE attempt_key=?",
            [key],
          );
          return Number(rows[0]?.attempts) <= 10;
        }),
      );
    },
    createSession(session, expectedPasswordHash, previousHash) {
      return ready(() =>
        database.transaction(async (connection) => {
          // Serialize with operator password resets and reject a password changed during hashing.
          const [admins] = await connection.execute<RowDataPacket[]>(
            "SELECT status,password_hash FROM admins WHERE id=? FOR UPDATE",
            [session.adminId],
          );
          if (
            admins[0]?.status !== "active" ||
            admins[0]?.password_hash !== expectedPasswordHash
          )
            throw new AuthError(
              401,
              "INVALID_CREDENTIALS",
              "Email or password is incorrect.",
            );
          if (previousHash)
            await connection.execute(
              "DELETE FROM admin_sessions WHERE token_hash=?",
              [previousHash],
            );
          await connection.execute(
            "DELETE FROM admin_sessions WHERE admin_id=? AND expires_at<=?",
            [session.adminId, session.createdAt],
          );
          await connection.execute(
            "INSERT INTO admin_sessions (token_hash,admin_id,created_at,last_seen_at,expires_at) VALUES (?,?,?,?,?)",
            [
              session.tokenHash,
              session.adminId,
              session.createdAt,
              session.createdAt,
              session.expiresAt,
            ],
          );
          await connection.execute(
            "UPDATE admins SET last_login_at=? WHERE id=?",
            [session.createdAt, session.adminId],
          );
        }),
      );
    },
    findSession(hash, now, idleMinutes) {
      return ready(() =>
        database.transaction(async (connection) => {
          const idleCutoff = new Date(now.getTime() - idleMinutes * 60000);
          const [rows] = await connection.execute<(RowDataPacket & Admin)[]>(
            `SELECT a.id,a.email,a.name,a.role
          FROM admin_sessions s JOIN admins a ON a.id=s.admin_id
          WHERE s.token_hash=? AND s.expires_at>? AND s.last_seen_at>? AND a.status='active' FOR UPDATE`,
            [hash, now, idleCutoff],
          );
          if (!rows[0]) {
            await connection.execute(
              "DELETE FROM admin_sessions WHERE token_hash=?",
              [hash],
            );
            return null;
          }
          await connection.execute(
            "UPDATE admin_sessions SET last_seen_at=? WHERE token_hash=?",
            [now, hash],
          );
          return publicAdmin(rows[0]);
        }),
      );
    },
    deleteSession(hash) {
      return ready(() =>
        database.withConnection(async (connection) => {
          await connection.execute(
            "DELETE FROM admin_sessions WHERE token_hash=?",
            [hash],
          );
        }),
      );
    },
  };
}
