import { createHash, randomBytes } from "node:crypto";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Config } from "../config/env.js";
import { DUMMY_PASSWORD_HASH, verifyPassword } from "./password.js";
import { AuthError, publicAdmin, type AuthStore } from "./types.js";

export const loginSchema = z
  .object({
    email: z.string().trim().toLowerCase().max(254).email(),
    password: z.string().min(1).max(128),
  })
  .strict();
export const cookieName = (config: Config) =>
  config.NODE_ENV === "production"
    ? "__Host-choicestakes_admin"
    : "choicestakes_admin";
export const tokenHash = (token: string) =>
  createHash("sha256").update(token).digest("hex");

export function readToken(request: FastifyRequest, config: Config) {
  const token = request.cookies[cookieName(config)];
  return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}
// Reuse this guard for every future protected admin API, not just its frontend page.
export async function requireAdmin(
  request: FastifyRequest,
  config: Config,
  store: AuthStore,
) {
  const token = readToken(request, config);
  const admin = token
    ? await store.findSession(
        tokenHash(token),
        new Date(),
        config.ADMIN_SESSION_IDLE_MINUTES,
      )
    : null;
  if (!admin)
    throw new AuthError(401, "UNAUTHENTICATED", "Please sign in to continue.");
  return admin;
}
export function assertAdminMutation(request: FastifyRequest, config: Config) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    if (
      !config.ADMIN_ORIGINS.includes(request.headers.origin ?? "") ||
      request.headers["x-requested-with"] !== "choicestakes-admin" ||
      request.headers["sec-fetch-site"] === "cross-site"
    )
      throw new AuthError(
        403,
        "ORIGIN_NOT_ALLOWED",
        "This request is not allowed. Reload the page and try again.",
      );
    if (
      !request.headers["content-type"]
        ?.toLowerCase()
        .startsWith("application/json")
    )
      throw new AuthError(415, "INVALID_REQUEST", "Use a JSON request.");
  }
}
export async function registerAuthRoutes(
  app: FastifyInstance,
  config: Config,
  store: AuthStore,
) {
  const name = cookieName(config);
  const options = {
    httpOnly: true,
    secure: config.NODE_ENV === "production",
    sameSite: "lax" as const,
    path: "/",
  };
  await app.register(
    async (auth) => {
      auth.addHook("onRequest", async (request, reply) => {
        reply.header("Cache-Control", "no-store");
        assertAdminMutation(request, config);
      });
      auth.post(
        "/login",
        { config: { rateLimit: { max: 100, timeWindow: "15 minutes" } } },
        async (request, reply) => {
          const parsed = loginSchema.safeParse(request.body);
          if (!parsed.success)
            throw new AuthError(
              400,
              "INVALID_LOGIN",
              "Enter a valid email address and password.",
            );
          if (!(await store.consumeLoginAttempt(parsed.data.email))) {
            reply.header("Retry-After", "900");
            throw new AuthError(
              429,
              "TOO_MANY_ATTEMPTS",
              "Too many sign-in attempts. Please try again in 15 minutes.",
            );
          }
          const admin = await store.findByEmail(parsed.data.email);
          const valid = await verifyPassword(
            parsed.data.password,
            admin?.passwordHash ?? DUMMY_PASSWORD_HASH,
          );
          if (!valid || !admin || admin.status !== "active")
            throw new AuthError(
              401,
              "INVALID_CREDENTIALS",
              "Email or password is incorrect.",
            );
          const token = randomBytes(32).toString("base64url");
          const createdAt = new Date();
          const previous = readToken(request, config);
          await store.createSession(
            {
              tokenHash: tokenHash(token),
              adminId: admin.id,
              createdAt,
              expiresAt: new Date(
                createdAt.getTime() + config.ADMIN_SESSION_TTL_HOURS * 3600000,
              ),
            },
            admin.passwordHash,
            previous ? tokenHash(previous) : undefined,
          );
          reply.setCookie(name, token, {
            ...options,
            maxAge: config.ADMIN_SESSION_TTL_HOURS * 3600,
          });
          return { success: true, data: { admin: publicAdmin(admin) } };
        },
      );
      auth.get("/me", async (request, reply) => {
        try {
          return {
            success: true,
            data: { admin: await requireAdmin(request, config, store) },
          };
        } catch (error) {
          if (error instanceof AuthError && error.statusCode === 401)
            reply.clearCookie(name, options);
          throw error;
        }
      });
      auth.post("/logout", async (request, reply) => {
        const token = readToken(request, config);
        if (token) await store.deleteSession(tokenHash(token));
        reply.clearCookie(name, options);
        return { success: true, data: { loggedOut: true } };
      });
    },
    { prefix: "/api/admin/auth" },
  );
}
