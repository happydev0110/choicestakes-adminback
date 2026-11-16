export class AuthError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export interface Admin {
  id: string;
  email: string;
  name: string;
  role: "admin";
}
export interface StoredAdmin extends Admin {
  passwordHash: string;
  status: "active" | "disabled";
}
export interface Session {
  tokenHash: string;
  adminId: string;
  createdAt: Date;
  expiresAt: Date;
}
export interface AuthStore {
  findByEmail(email: string): Promise<StoredAdmin | null>;
  consumeLoginAttempt(email: string): Promise<boolean>;
  createSession(
    session: Session,
    expectedPasswordHash: string,
    previousHash?: string,
  ): Promise<void>;
  findSession(
    hash: string,
    now: Date,
    idleMinutes: number,
  ): Promise<Admin | null>;
  deleteSession(hash: string): Promise<void>;
}
export function publicAdmin(admin: Admin): Admin {
  return {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    role: admin.role,
  };
}
