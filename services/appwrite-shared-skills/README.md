# LHIC Appwrite shared-skill registry

Deploy this directory as a Node.js Appwrite Function with `src/main.js` as its
entrypoint. Install dependencies with `npm ci` in this directory before
deployment.

Set these secret Function variables:

- `LHIC_SHARED_DATABASE_ID`
- `LHIC_SHARED_SKILLS_TABLE_ID`
- `LHIC_DEVICE_PAIRS_TABLE_ID`

Give the Function dynamic API key `rows.read` and `rows.write` scopes.
Do not grant direct client permissions to either table. Configure the Function
for public execution: `GET /skills`, the Magic URL callback, and device polling
are public; `POST /skills` independently validates an Appwrite JWT.

Create the following TablesDB tables with row security enabled:

| Table           | Required columns                                                                                                                                                                                                                                                 |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared_skills` | `name` string(128), `contentHash` string(128), `operationKey` string(256), `fingerprint` string(128), `payload` string(65535), `fastPathEligible` boolean, `status` enum(`pending`,`approved`,`rejected`,`revoked`), `authorId` string(36), `version` string(64) |
| `device_pairs`  | `codeHash` string(64), `userId` string(36), `secret` string(1024), `expiresAt` datetime                                                                                                                                                                          |

To approve a submission, open `shared_skills` in the Appwrite Console and set
its `status` to `approved`. Set the status to `rejected` to keep it private, or
to `revoked` to have clients remove their cached record during the next sync.

Add the Function callback origin as an Appwrite Web platform before using
`lhic shared enable`; Appwrite only redirects Magic URLs to registered URLs.

## Desktop Control Center

The native Control Center uses the same Function for privileged dashboard
routes under `/control/*`. Administration requires an Appwrite user JWT, and
every write requires either the configured bootstrap Appwrite account ID or an
explicit `admin` role row. Judge read routes accept either an Appwrite JWT with
a GitHub OAuth identity or an administrator-issued judge token.

Configure these additional Function secrets after the tables from
`appwrite.config.json` are deployed:

- `LHIC_BOOTSTRAP_ADMIN_ACCOUNT_ID`
- `LHIC_CONTROL_ROLES_TABLE_ID=control-roles`
- `LHIC_CONTROL_JUDGES_TABLE_ID=judge-grants`
- `LHIC_CONTROL_JUDGE_EMAILS_TABLE_ID=judge-email-grants`
- `LHIC_CONTROL_JUDGE_TOKENS_TABLE_ID=judge-auth-tokens`
- `LHIC_CONTROL_DEMO_KEYS_TABLE_ID=demo-api-keys`
- `LHIC_CONTROL_SECRETS_TABLE_ID=control-secrets`
- `LHIC_CONTROL_AUDIT_TABLE_ID=control-audit-events`
- `LHIC_CONTROL_DEMO_ASSETS_TABLE_ID=demo-assets`
- `LHIC_CONTROL_POLICY_PACKAGES_TABLE_ID=policy-packages`
- `LHIC_SECRET_ENCRYPTION_KEY` — a base64-encoded, 32-byte AES-256-GCM key

Enable GitHub OAuth in the Appwrite project for Judge Center. The Function can
check either the authenticated GitHub identity's immutable `providerUid` or its
provider email, both obtained from the OAuth identity rather than a mutable
GitHub login name. Administrator-issued judge tokens are shown only by their
create response and stored only as SHA-256 hashes. Demo API keys are also
shown only by their create response. Shared-library secrets are stored as
AES-GCM envelopes and list endpoints return metadata only.

Administrators register each Judge Center asset through `POST /control/assets`.
An asset must reference an existing credential-free HTTPS report, trace summary,
presentation, or guide, include its SHA-256 digest and production timestamp,
and cannot include credentials in its metadata. GitHub-allowlisted judges can
read only active assets through `GET /control/judge/catalog`; retired assets are
excluded immediately.

Game policy review uses a separate, metadata-only workflow. The desktop app
creates and locally verifies a deterministic ZIP containing only the policy
artifact, weights, action mapping, manifest, and an optional sanitized
evaluation report. `POST /control/policy-packages` accepts only an authenticated
member's hashes and credential-free HTTPS bundle URL, then records it as
`pending`; raw frames, gameplay recordings, and keyboard or mouse datasets are
never accepted. Administrators approve, reject, or revoke the record through
`PATCH /control/policy-packages/:id/status`. GitHub-allowlisted judges can read
only approved package metadata through `GET /control/judge/policy-packages`.
