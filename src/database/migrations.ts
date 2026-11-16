import { managementMigration } from "./management-migration.js";
export const migrations = [
  {
    name: "001_admin_auth",
    statements: [
      `CREATE TABLE IF NOT EXISTS admins (
      id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      email VARCHAR(254) COLLATE utf8mb4_bin NOT NULL,
      name VARCHAR(80) NOT NULL,
      password_hash VARCHAR(255) CHARACTER SET ascii NOT NULL,
      role ENUM('admin') NOT NULL DEFAULT 'admin',
      status ENUM('active','disabled') NOT NULL DEFAULT 'active',
      created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
      last_login_at DATETIME(3) NULL,
      UNIQUE KEY uq_admins_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`,
      `CREATE TABLE IF NOT EXISTS admin_sessions (
      token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      admin_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
      created_at DATETIME(3) NOT NULL,
      last_seen_at DATETIME(3) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      KEY ix_admin_sessions_admin (admin_id),
      KEY ix_admin_sessions_expiry (expires_at),
      CONSTRAINT fk_admin_sessions_admin FOREIGN KEY (admin_id) REFERENCES admins(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      `CREATE TABLE IF NOT EXISTS admin_login_attempts (
      attempt_key CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
      bucket BIGINT NOT NULL,
      attempts INT UNSIGNED NOT NULL,
      KEY ix_admin_attempt_bucket (bucket)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    ],
  },
  managementMigration,
];
