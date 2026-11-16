import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { RowDataPacket } from "mysql2/promise";
import { loadConfig } from "../config/env.js";
import { createDatabase, type Database } from "./mysql.js";
import { migrations } from "./migrations.js";
export async function migrate(database: Database) {
  await database.withConnection(async (connection) => {
    const [rows] = await connection.query<RowDataPacket[]>(
      "SELECT GET_LOCK(CONCAT('csadm_', SHA2(DATABASE(), 224)), 10) AS acquired",
    );
    if (Number(rows[0]?.acquired) !== 1)
      throw new Error(
        "Could not acquire the admin migration lock. Try again later.",
      );
    try {
      await connection.query(`CREATE TABLE IF NOT EXISTS admin_schema_migrations (
        name VARCHAR(100) PRIMARY KEY, checksum CHAR(64) NOT NULL,
        applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
      for (const migration of migrations) {
        const checksum = createHash("sha256")
          .update(migration.statements.join("\n"))
          .digest("hex");
        const [applied] = await connection.execute<RowDataPacket[]>(
          "SELECT checksum FROM admin_schema_migrations WHERE name=?",
          [migration.name],
        );
        if (applied[0]) {
          if (applied[0].checksum !== checksum)
            throw new Error("An applied admin migration was modified.");
          console.log("Already applied: " + migration.name);
          continue;
        }
        // MySQL DDL commits implicitly; these statements are safe to resume.
        for (const sql of migration.statements) await connection.query(sql);
        await connection.execute(
          "INSERT INTO admin_schema_migrations (name,checksum) VALUES (?,?)",
          [migration.name, checksum],
        );
        console.log("Applied: " + migration.name);
      }
    } finally {
      await connection.query(
        "SELECT RELEASE_LOCK(CONCAT('csadm_', SHA2(DATABASE(), 224)))",
      );
    }
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const database = createDatabase(loadConfig());
  try {
    await migrate(database);
  } catch {
    console.error(
      "Admin migration failed. Check MySQL connection, CREATE/REFERENCES permissions, and migration locks.",
    );
    process.exitCode = 1;
  } finally {
    await database.close();
  }
}
