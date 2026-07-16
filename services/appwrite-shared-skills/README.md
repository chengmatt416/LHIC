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
