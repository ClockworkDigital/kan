# GitHub App account connection

Register a GitHub App under ClockworkDigital → Settings → Developer settings →
GitHub Apps. Choose **Only on this account** for a private organization app.
A public app is needed only if other accounts must install it. Set the homepage
to the canonical Kan HTTPS origin and the user authorization callback to exactly
`https://<kan-host>/api/integrations/github/callback`. Keep token expiration on.
Leave **Request user authorization (OAuth) during installation** unchecked;
users must start authorization from Kan so that the callback has bound state.
Disable webhooks if unused. No private key, installation token or alternate login
provider is needed. Install into ClockworkDigital and choose only intended repos.

Default repository permissions: Metadata read and Issues read/write (read suffices
for progress; write is needed for sync and submissions). Optional features need
additional grants: Projects read for project imports; Administration write for
topics; Contents, Workflows and Administration write for repository policy setup.
Do not grant these by default just to connect. Existing PAT connections remain
supported, including features outside this app's permissions.

Set `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` in the operator-owned
Compose environment, then recreate the reviewed app image. These are separate
from social-login GitHub variables. Never put secrets in NEXT_PUBLIC variables,
source control, browser storage or diagnostics. No credentials are supplied by
this change. The deployment must retain its private gateway-only networking.
The callback requires normal native/Formwork authentication and must be routed
through that policy; it never creates a Kan login. Keep `formwork-token` private.

Settings → Integrations → Connect GitHub uses PKCE S256 and a ten-minute,
one-use encrypted state bound to the current Kan UUID, tenant, native session
(or Formwork identity snapshot) and HttpOnly browser cookie. Pending state uses
an internal integration row excluded from provider listings; no schema migration
is required. The existing nullable refreshToken column stores encrypted verified
GitHub numeric ID/login metadata for App connections, **not a refresh token**.
PAT replacement clears it. Email is never used to link accounts.

This first version requires explicit reconnect after GitHub's returned expiry
(normally eight hours). Refresh tokens are discarded, not persisted or used.
Background sync is unaffected when the app private key is configured: set
`GITHUB_APP_PRIVATE_KEY` to the base64 of a PEM from the app's Credentials → Key
pairs page, and Kan syncs with installation tokens instead of a person's
connection. Without it, sync stops when the owner's authorization expires. Disconnect removes local credentials and
invalidates pending callbacks; revoke the app authorization in GitHub as well
to revoke GitHub-side grants. No Formwork credential is renewed, and no mappings,
conflict baselines or selected repository settings are removed.

References: [GitHub web flow](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app),
[token lifetime](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens).
