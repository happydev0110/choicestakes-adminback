import type {
  Admin,
  AuthStore,
  Session,
  StoredAdmin,
} from "../src/auth/types.js";
import { AuthError, publicAdmin } from "../src/auth/types.js";
export class MemoryStore implements AuthStore {
  admins = new Map<string, StoredAdmin>();
  sessions = new Map<string, Session & { lastSeenAt: Date }>();
  attempts = new Map<string, number>();
  async findByEmail(email: string) {
    return this.admins.get(email) ?? null;
  }
  async consumeLoginAttempt(email: string) {
    const count = (this.attempts.get(email) ?? 0) + 1;
    this.attempts.set(email, count);
    return count <= 10;
  }
  async createSession(session: Session, expected: string, previous?: string) {
    const admin = [...this.admins.values()].find(
      (a) => a.id === session.adminId,
    );
    if (!admin || admin.status !== "active" || admin.passwordHash !== expected)
      throw new AuthError(
        401,
        "INVALID_CREDENTIALS",
        "Email or password is incorrect.",
      );
    if (previous) this.sessions.delete(previous);
    this.sessions.set(session.tokenHash, {
      ...session,
      lastSeenAt: session.createdAt,
    });
  }
  async findSession(
    hash: string,
    now: Date,
    idleMinutes: number,
  ): Promise<Admin | null> {
    const session = this.sessions.get(hash);
    const admin = [...this.admins.values()].find(
      (a) => a.id === session?.adminId,
    );
    if (
      !session ||
      !admin ||
      admin.status !== "active" ||
      session.expiresAt <= now ||
      session.lastSeenAt.getTime() <= now.getTime() - idleMinutes * 60000
    ) {
      this.sessions.delete(hash);
      return null;
    }
    session.lastSeenAt = now;
    return publicAdmin(admin);
  }
  async deleteSession(hash: string) {
    this.sessions.delete(hash);
  }
}
export const fakeDatabase = {
  enabled: true,
  async ping() {},
  async close() {},
};
export const headers = {
  origin: "http://localhost:6001",
  "x-requested-with": "choicestakes-admin",
  "content-type": "application/json",
};
export function sessionCookie(value: string | string[] | undefined) {
  return String(value).split(";")[0]!;
}
