import { z } from "zod";
const boolean = z
  .enum(["true", "false"])
  .transform((value) => value === "true");
const port = z.coerce.number().int().min(1).max(65535);
const schema = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    HOST: z.string().min(1).default("127.0.0.1"),
    PORT: port.default(4001),
    LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    ADMIN_ORIGINS: z
      .string()
      .default("http://localhost:3001,http://127.0.0.1:3001")
      .transform((value) => value.split(",").map((origin) => origin.trim()))
      .pipe(
        z
          .array(
            z.string().refine((origin) => {
              try {
                const url = new URL(origin);
                return (
                  ["http:", "https:"].includes(url.protocol) &&
                  url.origin === origin
                );
              } catch {
                return false;
              }
            }, "Use exact http(s) origins without paths or trailing slashes"),
          )
          .min(1),
      ),
    DB_ENABLED: boolean.default(false),
    MYSQL_HOST: z.string().min(1).default("127.0.0.1"),
    MYSQL_PORT: port.default(3306),
    MYSQL_DATABASE: z.string().min(1).default("choicestakes"),
    MYSQL_USER: z.string().default(""),
    MYSQL_PASSWORD: z.string().default(""),
    MYSQL_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
    MYSQL_SSL: boolean.default(false),
    MYSQL_SSL_CA: z.string().default(""),
    APIMATIC_CURRENCY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,16}$/)
      .default("USD"),
    PLAYER_SESSION_IDLE_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(1440)
      .default(60),
    ADMIN_SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(8),
    ADMIN_SESSION_IDLE_MINUTES: z.coerce
      .number()
      .int()
      .min(5)
      .max(120)
      .default(30),
  })
  .superRefine((env, ctx) => {
    const issue = (field: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [field], message });
    if (env.DB_ENABLED && !env.MYSQL_USER)
      issue("MYSQL_USER", "Required when DB_ENABLED=true");
    if (env.MYSQL_SSL_CA && !env.MYSQL_SSL)
      issue("MYSQL_SSL_CA", "Requires MYSQL_SSL=true");
    if (env.NODE_ENV === "production") {
      if (!env.DB_ENABLED) issue("DB_ENABLED", "Must be true in production");
      if (!env.MYSQL_PASSWORD)
        issue("MYSQL_PASSWORD", "Required in production");
      if (env.ADMIN_ORIGINS.some((origin) => !origin.startsWith("https://")))
        issue("ADMIN_ORIGINS", "Use HTTPS origins in production");
    }
  });
export type Config = z.infer<typeof schema>;
export function loadConfig(input: NodeJS.ProcessEnv = process.env): Config {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new Error(
      "Invalid configuration: " +
        parsed.error.issues
          .map((issue) => issue.path.join(".") + ": " + issue.message)
          .join("; "),
    );
  return parsed.data;
}
