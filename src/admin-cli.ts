import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { RowDataPacket } from "mysql2/promise";
import { loadConfig } from "./config/env.js";
import { createDatabase } from "./database/mysql.js";
import { hashPassword } from "./auth/password.js";

const account = z.object({
  email: z.string().trim().toLowerCase().max(254).email(),
  name: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[^\u0000-\u001f\u007f]+$/),
});
async function main() {
  const { values, positionals } = parseArgs({
    options: { email: { type: "string" }, name: { type: "string" } },
    allowPositionals: true,
  });
  const command = positionals[0];
  if (!["create", "reset-password"].includes(command ?? "") || !values.email)
    throw new Error(
      'Usage: npm run admin:create -- --email you@example.com --name "Administrator" OR npm run admin:reset-password -- --email you@example.com',
    );
  const parsed = account.safeParse({
    email: values.email,
    name: values.name ?? "Administrator",
  });
  if (!parsed.success)
    throw new Error("Use a valid email and a name of 2–80 characters.");
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Run this command in an interactive terminal. Password input is hidden; password arguments are not accepted.",
    );
  const database = createDatabase(loadConfig());
  try {
    await database.ping();
    let muted = false;
    const output = new Writable({
      write(chunk, _encoding, callback) {
        if (!muted) process.stdout.write(chunk);
        callback();
      },
    });
    const terminal = createInterface({
      input: process.stdin,
      output,
      terminal: true,
    });
    const abort = new AbortController();
    terminal.on("SIGINT", () => abort.abort());
    async function secret(prompt: string) {
      process.stdout.write(prompt);
      muted = true;
      try {
        return await terminal.question("", { signal: abort.signal });
      } finally {
        muted = false;
        process.stdout.write("\n");
      }
    }
    let password: string;
    try {
      password = await secret("Password (12–128 characters): ");
      if (password.length < 12 || password.length > 128)
        throw new Error("Password must contain 12–128 characters.");
      if (password !== (await secret("Confirm password: ")))
        throw new Error("Passwords do not match.");
    } finally {
      terminal.close();
    }
    const hash = await hashPassword(password);
    password = "";
    await database.transaction(async (connection) => {
      const [existing] = await connection.execute<RowDataPacket[]>(
        "SELECT id FROM admins WHERE email=? FOR UPDATE",
        [parsed.data.email],
      );
      if (command === "create") {
        if (existing.length)
          throw new Error("An administrator already uses this email.");
        await connection.execute(
          "INSERT INTO admins (id,email,name,password_hash) VALUES (?,?,?,?)",
          [randomUUID(), parsed.data.email, parsed.data.name, hash],
        );
      } else {
        if (!existing[0]) throw new Error("Administrator not found.");
        await connection.execute(
          "UPDATE admins SET password_hash=? WHERE id=?",
          [hash, existing[0].id],
        );
        await connection.execute(
          "DELETE FROM admin_sessions WHERE admin_id=?",
          [existing[0].id],
        );
      }
    });
    console.log(
      command === "create"
        ? "Administrator created. You can now sign in."
        : "Password updated and all existing sessions revoked.",
    );
  } finally {
    await database.close();
  }
}
main().catch((error) => {
  // Only explicit operator validation messages are safe to display; driver messages may contain inputs.
  const message =
    error instanceof Error && !("code" in error)
      ? error.message
      : "Admin setup failed. Check database configuration, migrations, and permissions.";
  console.error(message);
  process.exitCode = 1;
});
