# Kan with Formwork

This fork adds gateway identity support, protected machine API access and GitHub
issue sync using the PAT saved in the authenticated user's Kan integration.
Upstream remains https://github.com/kanbn/kan.

Read `compose.yaml` for the independent Kan/PostgreSQL deployment. Set KAN_IMAGE,
FORMWORK_TENANT_ID, KAN_URL, FORMWORK_URL, KAN_SECRET_DIR and KAN_GATEWAY_NETWORK
in an operator-owned environment file. Keep secrets outside the repository.
The secret directory contains database-admin, runtime-database, auth-secret and
admin-api-key. The bootstrap loads secrets from mounted files.

Never enable gateway identity on a directly published app port. Caddy must strip
all supplied identity headers, authenticate the caller, enforce current Formwork
policy and forward only verified tenant/user/group/issued-at headers. Provision
approved stable UUIDs with provision.ts; email is not an identity key. Kan retains
its own database and native workspace permissions.

Build with Node 24:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm --filter @kan/mcp build
corepack pnpm --filter @kan/auth test
NEXT_PUBLIC_USE_STANDALONE_OUTPUT=true BETTER_AUTH_SECRET=build-only-placeholder-secret-at-least-32-characters CI=true corepack pnpm --filter @kan/web exec next build --turbo
docker build -f deploy/formwork/Dockerfile -t kan:formwork .
```

The Dockerfile packages the standalone production build. Apply reviewed Drizzle
migrations using an operator connection before starting a fresh database. Retain
the database volume on upgrades; never use `down -v` on a live installation.

`formwork-token` is a private verification callback and must be blocked at the
external gateway. Machine API grants bind a stable user UUID, tenant, hostname,
group snapshot and expiry of at most eight hours. There is no automatic renewal.
Current Formwork blocks/rules and native Kan permissions apply on each request.
`issue-mcp.ts` is a privileged operator tool, not a public issuance endpoint.

See [GitHub issue sync](github-sync/README.md) for scheduling, state recovery and
conflict handling. The GitHub PAT is decrypted only in Kan; replacement or
removal takes effect on the next request. The issue worker has a separate, revocable background delegation; browser and
MCP grants still expire after eight hours. See the sync guide for its restrictions.

GitHub label names, colours and issue assignments flow into board-local Kan
labels. See [label ownership and recovery](github-sync/README.md#github-label-ownership).

The real-image verifier requires the sibling Formwork checkout and its gateway
configuration; set `FORMWORK_ROOT` to test another checkout. Deployment-specific
notes, backups and environment files belong in the ignored `.runtime/`
directory, not the public fork. Existing upstream
broader lint/type errors remain; focused auth and GitHub sync checks are provided.

The web healthcheck uses Node to fetch `/api/v1/health` on the container's
loopback within four seconds and requires `status` and `database` to be `ok`; the
route runs `SELECT 1`. It needs no shell, Python or curl and works with existing
images. Formwork's monitor runs this same healthcheck when its tool registry sets
`readyHealthcheck: true` for `web`. Through Caddy, `/api/v1/*` still requires
gateway sign-in or a verified bearer key plus current policy.

Kan uses a dedicated egress network for GitHub HTTPS calls. PostgreSQL remains
on its internal network, and neither service publishes a port. Adjust the
egress subnet if it overlaps an existing deployment.

## Backup and restore

Kan's state is in its PostgreSQL database. This deployment configures no object
storage, so attachment and avatar uploads are unavailable; back up any bucket
separately if one is enabled later. Run both commands with the deployment's
environment file and, when it differs from `compose.yaml`, its complete
colon-separated `COMPOSE_FILE` list:

```sh
deploy/formwork/scripts/backup.sh <compose-env-file> <new-output-directory>
deploy/formwork/scripts/restore.sh <compose-env-file> <backup-directory> <new-database-name>
```

The backup takes one consistent `pg_dump` snapshot through the database
container's local socket, without stopping or reconfiguring containers. It
writes a checksummed manifest last and removes its output on failure. Formwork's
coordinated exporter invokes it through the operator's tool registry, with
`deploy/formwork` as the project directory.

Restore validates the export, then creates a new database in the selected
project's running PostgreSQL. It refuses existing names, so it cannot replace
live data, and drops its own database if `pg_restore` fails. Nothing is
reconfigured; review the copy before pointing a runtime credential at it.
Restored grants require the runtime role to exist already. Kan enables
row-level security without policies, so recreate that role with its original
attributes, including `BYPASSRLS`, before restoring into a fresh cluster.

Exports contain sessions, hashed API keys and encrypted GitHub tokens, but no
credentials from the secret directory. Keep the secret directory's recovery copy
separately protected: `auth-secret` is required to decrypt saved GitHub tokens,
and the database files recreate the owner and runtime roles. Passwords are read
from files or sent on stdin, never passed as arguments or logged.

`verify-recovery.py` runs the disposable drill: representative data, the
coordinated exporter, failure cleanup, refused restores, a restore into a new
project, row/grant comparison, and gateway, emergency-block and native
permission checks. It uses the sibling Formwork checkout (or `FORMWORK_ROOT`)
and `KAN_TEST_IMAGE`, and removes every container, network and volume it creates.
