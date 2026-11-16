import { loadConfig } from "./config/env.js";
import { buildApp } from "./app.js";
async function main() {
  const config = loadConfig();
  const app = await buildApp(config);
  const shutdown = async () => {
    await app.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
    if (!config.DB_ENABLED)
      app.log.warn(
        "MySQL is disabled. Configure .env and migrate before creating administrators.",
      );
  } catch {
    await app.close();
    throw new Error(
      "Admin API could not start. Check the port and configuration.",
    );
  }
}
main().catch((error) => {
  console.error(
    error instanceof Error ? error.message : "Admin API startup failed.",
  );
  process.exitCode = 1;
});
