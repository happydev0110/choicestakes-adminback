import { loadConfig } from "../config/env.js";
import { createDatabase } from "./mysql.js";
const database = createDatabase(loadConfig());
try {
  await database.ping();
  console.log("Admin MySQL connection succeeded.");
} catch {
  console.error(
    "Admin MySQL connection failed. Check DB_ENABLED and MYSQL_* in .env.",
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
