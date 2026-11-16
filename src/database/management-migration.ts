export const managementMigration = {
  name: "002_admin_management",
  statements: [
    `CREATE TABLE IF NOT EXISTS admin_audit_log (
    id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    admin_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    action VARCHAR(64) CHARACTER SET ascii NOT NULL,
    target_id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    currency VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NULL,
    before_json JSON NOT NULL,
    after_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY ix_admin_audit_target (target_id,created_at),
    KEY ix_admin_audit_actor (admin_id,created_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  ],
};
