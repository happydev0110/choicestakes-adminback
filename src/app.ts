import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import cookie from "@fastify/cookie";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Config } from "./config/env.js";
import {
  createDatabase,
  type Database,
  type DatabaseHealth,
} from "./database/mysql.js";
import { createAuthStore } from "./auth/store.js";
import { registerAuthRoutes } from "./auth/routes.js";
import { AuthError, type AuthStore } from "./auth/types.js";
import { createManagementStore } from "./management/store.js";
import { registerManagementRoutes } from "./management/routes.js";
import type { ManagementStore } from "./management/types.js";

export async function buildApp(
  config: Config,
  dependencies: {
    database?: DatabaseHealth;
    authStore?: AuthStore;
    managementStore?: ManagementStore;
  } = {},
) {
  const app = Fastify({
    bodyLimit: 8192,
    requestTimeout: 10000,
    connectionTimeout: 10000,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
    logger:
      config.NODE_ENV === "test"
        ? false
        : {
            level: config.LOG_LEVEL,
            redact: [
              "req.headers.cookie",
              "req.headers.authorization",
              'res.headers["set-cookie"]',
            ],
            serializers: {
              req: (req: { method: string; url: string }) => ({
                method: req.method,
                url: req.url.split("?")[0] ?? "/",
              }),
            },
          },
  });
  const database = dependencies.database ?? createDatabase(config);
  app.addHook("onClose", async () => database.close());
  try {
    await app.register(cookie);
    await app.register(helmet);
    await app.register(rateLimit, { global: false });
    app.addHook("onRequest", async (request, reply) => {
      reply.header("X-Request-Id", request.id);
      reply.header("Cache-Control", "no-store");
    });
    app.setErrorHandler((error, request, reply) => {
      const statusCode =
        error instanceof Error && "statusCode" in error
          ? Number(error.statusCode)
          : 500;
      const status =
        error instanceof AuthError
          ? error.statusCode
          : statusCode >= 400 && statusCode < 500
            ? statusCode
            : 500;
      // Never log request bodies, raw driver errors, tokens, or credentials.
      if (status >= 500)
        request.log.error(
          {
            requestId: request.id,
            code: error instanceof AuthError ? error.code : "INTERNAL_ERROR",
          },
          "Admin request failed",
        );
      return reply.code(status).send({
        success: false,
        error: {
          code:
            error instanceof AuthError
              ? error.code
              : status === 429
                ? "TOO_MANY_ATTEMPTS"
                : status >= 500
                  ? "INTERNAL_ERROR"
                  : "INVALID_REQUEST",
          message:
            error instanceof AuthError
              ? error.message
              : status === 429
                ? "Too many requests. Please try again later."
                : "The request could not be completed.",
        },
        requestId: request.id,
      });
    });
    app.setNotFoundHandler((_request, reply) =>
      reply.code(404).send({
        success: false,
        error: { code: "NOT_FOUND", message: "Endpoint not found." },
      }),
    );
    app.get("/health", async () => ({
      success: true,
      service: "choicestakes-adminback",
    }));
    app.get("/health/ready", async (_request, reply) => {
      try {
        await database.ping();
        return { success: true };
      } catch {
        return reply.code(503).send({
          success: false,
          error: {
            code: "DATABASE_UNAVAILABLE",
            message: "Admin database is not ready.",
          },
        });
      }
    });
    const authStore =
      dependencies.authStore ?? createAuthStore(database as Database);
    await registerAuthRoutes(app, config, authStore);
    await registerManagementRoutes(
      app,
      config,
      authStore,
      dependencies.managementStore ??
        createManagementStore(database as Database, config),
    );
    return app;
  } catch (error) {
    await app.close();
    throw error;
  }
}
