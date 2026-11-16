# Choicestakes admin backend

Node.js, TypeScript, Fastify, and MySQL authentication and management for `choicestakes-admin`.
Requires Node.js 22.12+. Uses the existing platform MySQL database with separate
`admins`, `admin_sessions`, `admin_login_attempts`, and `admin_schema_migrations` tables.
Administrator authentication is separate from player credentials and sessions.

## Local setup

1. Run `npm ci`.
2. Copy `.env.example` to `.env` and fill in `MYSQL_*`; set `DB_ENABLED=true`.
   Use the same database as `choicestakes-backend` so management can access players and games.
   The database must already exist. Do not put passwords in frontend variables.
3. Run:

```sh
npm run db:check
npm run db:migrate
npm run admin:create -- --email you@example.com --name "Platform Administrator"
npm run dev
```

The create command prompts for a 12–128 character password twice with input hidden.
There are no default credentials, public registration endpoint, or automatic admin grants.
Duplicate emails are rejected. Anyone with permission to run this CLI and write to the
admin tables can provision an administrator; keep that access restricted to operators.

In `choicestakes-admin/.env.local`:

```dotenv
ADMIN_BACKEND_INTERNAL_URL=http://127.0.0.1:6051
```

Start the frontend with `npm run dev` (port 6001). The admin browser calls the frontend's
same-origin `/api/admin/auth/*` and `/api/admin/manage/*` proxies; they forward to this service.
`ADMIN_ORIGINS` must contain the exact URL used to open the admin frontend,
including the port, with no trailing slash. Add your LAN origin when accessing from another device.

## Deployment

Set `NODE_ENV=production`, `DB_ENABLED=true`, and `ADMIN_ORIGINS=https://YOUR_ADMIN_DOMAIN`.
Use a real database password. Keep the API bound to loopback if both services share a server.
Configure the frontend's `ADMIN_BACKEND_INTERNAL_URL` to reach this backend from its server/container.
Use HTTPS for the browser-facing admin frontend and for backend links crossing untrusted networks.

Deployment order for management:

1. In `choicestakes-backend`, run `npm run db:migrate` (including `005_game_visibility`), then `npm run build` and restart the player API.
2. In this project, run `npm ci`, `npm run db:migrate` (including `002_admin_management`), `npm run build`, then restart it under your process manager.
3. Build and restart `choicestakes-admin`.

Both backends must use the same `MYSQL_*` database and `APIMATIC_CURRENCY`.
Set this service's `PLAYER_SESSION_IDLE_MINUTES` to the player API's `SESSION_IDLE_MINUTES`.
Runtime database permissions:

- SELECT, INSERT, UPDATE, DELETE on the authentication tables.
- SELECT, UPDATE on `players`; SELECT, DELETE on `player_sessions`.
- SELECT on `apimatic_games` and `apimatic_catalog_sync`.
- SELECT, INSERT, UPDATE, DELETE on `apimatic_game_settings` and `apimatic_game_categories`.
- INSERT on `admin_audit_log`.

Migrations also need CREATE and REFERENCES. No grants or database creation run automatically.

## Authentication

- POST `/api/admin/auth/login`: JSON `{email,password}`.
- GET `/api/admin/auth/me`: the authenticated administrator's id, name, email, role.
- POST `/api/admin/auth/logout`: JSON `{}`, revokes the current session.
- GET `/health`: API liveness. GET `/health/ready`: MySQL connectivity.
- Mutations require an allowed Origin, JSON, and `X-Requested-With: choicestakes-admin`.
- Passwords use salted scrypt; raw passwords are never stored.
- Random session tokens live in HttpOnly, SameSite=Lax, host-only cookies.
  Only SHA-256 hashes are stored in MySQL.
- Production cookie: `__Host-choicestakes_admin` with Secure.
  Development cookie: `choicestakes_admin`.
- Sessions expire after 8 hours, or 30 minutes idle, by default.
- Login replaces the presented previous session. Logout revokes it immediately.
- Every session check verifies the admin is still active.
- Login attempts are limited per email in MySQL and per connection IP in the API.
  Forwarded IP headers are not trusted; with the frontend proxy, the IP limit is shared.
  For multiple instances/high traffic, also configure trusted edge rate limiting.
- Unknown, disabled, and incorrect-password accounts receive the same login error.
- The exported `requireAdmin` guard must protect every future admin API.

Reset a password from an operator terminal (revokes all sessions):

```sh
npm run admin:reset-password -- --email you@example.com
```

To disable an administrator, an authorized operator can set `admins.status='disabled'`
and delete that account's `admin_sessions`. No account-management UI is included yet.
There is no email password-reset flow or MFA in this initial login implementation.

## Player and game management

All management routes require an active administrator session. Mutations also require
the same Origin/JSON/header checks as authentication. There is no public management API.

- GET `/api/admin/players`: search by display name, email or ID; filter active/suspended; 25 records per page.
- GET `/api/admin/players/:id`: account details and active-session count.
- PATCH `/api/admin/players/:id`: update display name and active/suspended status. Suspension revokes player sessions and blocks new play; existing wins/refunds can still settle.
- GET `/api/admin/games`: search, provider, category, provider availability and portal visibility filters; 25 records per page, plus catalog sync status.
- GET `/api/admin/games/:id`: imported metadata and operator settings.
- PATCH `/api/admin/games/:id`: set portal visibility and reviewed categories, including Featured and New Games.

Edits include the expected previous values; conflicting edits return 409 and require
reopening the editor. Each successful change is recorded with its administrator and
before/after values in `admin_audit_log`, in the same transaction as the change.

Game visibility is separate from provider availability. Hidden games disappear from
the portal catalog and cannot start new sessions. Provider imports preserve visibility
and category assignments. Showing a game cannot override provider unavailability.
Refresh in the admin page reloads the database list; provider imports still run through
the player backend's automatic sync or `npm run games:sync`.

Player deletion, credential changes, balance editing, and provider metadata editing
are not exposed. Dashboard statistics, orders, and analytics remain template data;
the Users and Games pages use the database with explicit empty/error states.

## Validation

```sh
npm run typecheck
npm test
npm run build
```

HTTP/security tests use an injected in-memory store, never production credentials.
For SQL integration checks, create a disposable database ending in `_test`, configure
`MYSQL_TEST_DATABASE` and MySQL credentials in your local environment, then run:

```sh
npm run db:auth:test
npm run db:management:test
```

The authentication check applies admin migrations to that explicitly selected test database.
The management check also applies the platform migrations from the sibling
`choicestakes-backend` project. It checks suspension, edit conflicts, visibility across
provider refreshes, categories, and audit rollback. Both remove their own fixture records.
Never point these checks at an existing platform database.
