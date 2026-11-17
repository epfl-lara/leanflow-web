# EPFL sign-in

Prepare the EPFL app registration first. Entra sign-in is disabled by default;
adding credentials alone does not enable it. Keep the current service running
while preparing and reviewing the change in a separate checkout.

## Ask EPFL to register the app

Give the EPFL administrator these details:

| Field        | Value                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------- |
| Name         | LeanFlow                                                                                  |
| Description  | A web workspace from EPFL LARA for writing and verifying Lean proofs, with AI assistance. |
| Homepage     | `https://leanflow.epfl.ch/`                                                               |
| Redirect URI | `https://leanflow.epfl.ch/api/auth/entra/callback`                                        |
| Platform     | Web; authentication is handled by the Node server.                                        |
| Protocol     | OpenID Connect, authorization code flow with PKCE.                                        |
| Audience     | EPFL's directory only, single tenant.                                                     |
| Scopes       | `openid profile email`                                                                    |

For another installation, replace the hostname in both URLs. The redirect URI
must match the application's configured HTTPS origin plus
`/api/auth/entra/callback`, including any nonstandard port. Use a GET/query
authorization response. Implicit grants, Microsoft Graph directory access,
mail access, and refresh tokens are not needed for sign-in.

Ask for the application (client) ID, directory (tenant) ID, and client secret
**value**, with its expiration date and the person responsible for rotation.
Share the secret through an approved private channel. Keep it on the server;
never put it in client code, a commit, or a browser test fixture.

Ask the administrator to confirm who may access the enterprise application
and arrange any required consent and user/group assignments. Start with a
small pilot group. Before a broader rollout, confirm that the assignments cover
the intended EPFL students and staff. A single-tenant registration can include
guest accounts in that tenant; use EPFL's assignment policy to define the
approved population.

EPFL's [registration guidance](https://inside.epfl.ch/identite-numerique/en/submit-your-application/)
requires an EPFL sign-in. Their public
[examples](https://github.com/epfl-si/entra-id-auth-examples) show integration
patterns. Microsoft's guidance covers
[Web redirect URIs](https://learn.microsoft.com/en-us/entra/identity-platform/how-to-add-redirect-uri),
[authorization code flow](https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-auth-code-flow),
and [user assignments](https://learn.microsoft.com/en-us/entra/identity-platform/howto-restrict-your-app-to-a-set-of-users).

### Confirm the ID-token claims

Keep the standard Entra `tid` (tenant ID) and `oid` (user object ID) claims in
the **OIDC ID token**, alongside EPFL's additional claims. LeanFlow identifies
an account by the verified tenant and object IDs. Missing or invalid IDs stop
sign-in; SCIPER, GASPAR and email claims do not replace them.

EPFL can also provide `uniqueid` (SCIPER), `gaspar`, `given_name`,
`family_name`, and `mail`. For the initial display name, LeanFlow uses `name`
when available, then the given and family names, then `EPFL user`. Users can
confirm or change that name during account setup. The other EPFL claims are
not used to grant access or automatically link existing accounts.

Ask the administrator to confirm these are ID-token claims, rather than only
SAML attributes or access-token claims. The pilot must verify the actual
returned token; public discovery alone cannot confirm app assignments,
consent, credentials, or user claims. See Microsoft's
[ID-token claims reference](https://learn.microsoft.com/en-us/entra/identity-platform/id-token-claims-reference).

## Configure a linked-account pilot

For a later test deployment, add these settings to its private environment
file. Use the registered IDs and secret value; do not copy the placeholders:

```dotenv
STUDIO_ORIGIN=https://leanflow.epfl.ch
STUDIO_ENTRA_ENABLED=true
STUDIO_ENTRA_TENANT_ID=<EPFL-directory-ID>
STUDIO_ENTRA_CLIENT_ID=<application-ID>
STUDIO_ENTRA_CLIENT_SECRET=<private-secret-value>
STUDIO_ENTRA_ALLOW_SIGNUP=false
```

Use a separate app registration and origin for a staging server. Enabling
sign-in requires all settings to be valid; an incomplete configuration stops
startup with an actionable error. Disabled sign-in makes no identity-provider
requests and hides the EPFL controls.

Existing users first sign in with their invitation token, open **Assistant
settings**, and choose **Link EPFL account**. They then authenticate with the
EPFL identity they intend to use. Linking preserves the local account ID,
projects, chats, personal provider connection, and role. Accounts are never
linked automatically by name or email address.

With signup disabled, only linked accounts can use EPFL sign-in. Invitation
tokens remain valid. Keep the owner's token privately available for recovery.
New users do not receive administrator privileges through SSO.

Sign-in and session renewal use a popup. Allow popups for the workspace if the
browser blocks one. Renewal checks the workspace account before restoring
access and keeps unsaved editor text and chat drafts in the original tab.
Transactions expire after a short interval and are lost on server restart;
start sign-in again if interrupted.

## Review before broader access

Verify the following on the test deployment with pilot identities:

1. Existing invitation-token login and logout still work.
2. A linked user can sign in with EPFL and see their existing projects.
3. An unlinked user is refused while signup is disabled.
4. Expired-session renewal returns to the same account without losing drafts.
5. Choosing another identity during renewal fails without changing accounts.
6. Owner and administrator roles remain explicitly managed in LeanFlow.

Once EPFL approves the wider audience and the service has suitable capacity,
set `STUDIO_ENTRA_ALLOW_SIGNUP=true` to allow approved, unlinked identities to
create regular accounts on first sign-in. Users who already have a token
account should link it before using this flow to avoid a separate account.
Review [hosting capacity](Configuration.md#worker-capacity) before expanding
access. EPFL SSO does not remove the service's network/VPN restriction or
provide users with RCP inference keys; personal provider setup still applies.

Deployment remains a separate step. Wait for active proof runs, checks, and
project setup to finish before any service restart. To disable SSO later, set
`STUDIO_ENTRA_ENABLED=false` and apply it during an idle restart. This stops new
EPFL sign-ins; it does not revoke already-issued LeanFlow session cookies.

## Run isolated checks

From the checkout, with Node 24 or newer:

```sh
npm ci
npm test
npm run check
npm run lint
npm run build
```

The Entra tests use a simulated identity provider and signed fixture tokens.
They do not contact Microsoft or use real credentials. Browser checks use
mocked accounts and projects. Start a disposable local client server:

```sh
npm --workspace @leanweb/client run dev -- --host 127.0.0.1 --port 3109 --strictPort
```

Then run these checks from another terminal in the same checkout. Use an
already-installed Playwright Chromium browser:

```sh
STUDIO_TEST_URL=http://127.0.0.1:3109 node scripts/check-entra-auth-ui.mjs
STUDIO_TEST_URL=http://127.0.0.1:3109 node scripts/check-auth-recovery-ui.mjs
STUDIO_TEST_URL=http://127.0.0.1:3109 node scripts/check-profile-ui.mjs
```

Stop the disposable client server after checking. These checks do not require
restarting the deployed service.
