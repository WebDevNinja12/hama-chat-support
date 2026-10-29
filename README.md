# Hama Enterprise Ng Chat Support

Live chat support for Hama Enterprise Ng (RC 8827959), serving residential, commercial and industrial clients for painting, interior design and exterior design.

## Existing application

- Node.js 22+, Express, Socket.IO and SQLite (`node:sqlite`)
- Customer chat widget, rule-based bot, optional Anthropic replies, agent dashboard and admin document library
- Existing test command: `npm test`

## Persistence and Render

Set `DATA_DIR` to a persistent directory. On Render, attach a persistent disk and mount it at the same path used by `DATA_DIR`; without persistent storage, local SQLite and uploaded files may be lost on redeploy or instance replacement.

The current application still uses SQLite. PostgreSQL support via `DATABASE_URL` and JSON-file fallback are not enabled by this branch. Do not set `DATABASE_URL` expecting migration or PostgreSQL storage to work yet. Managed external database options include [Neon](https://neon.tech/) and [Supabase](https://supabase.com/); confirm their current free-tier limits, backups and connection settings before production use.

## Email alerts

Callback and lead API flows attempt email alerts when `ALERT_EMAILS`, `EMAIL_PROVIDER`, and `EMAIL_API_KEY` are configured. `EMAIL_PROVIDER` supports `resend` or `brevo`; configure `EMAIL_FROM` as required by the provider. `DASHBOARD_URL` is used in alert content. Email failures are intentionally isolated from chat requests. Alert throttling currently uses in-process memory and resets when the service restarts.

## Security

- Set a strong `ADMIN_PASSWORD` before first production startup.
- Set a unique `JWT_SECRET`; never use the development fallback in production.
- Keep `.env`, API keys and the `DATA_DIR` database private.
- Restrict widget origins before embedding the chat on a public site.

## Tests

Run existing tests with:

```sh
npm test
```

## Feature-extension status

This branch adds SQLite tables and initial API endpoints for call-backs, leads, ratings, unanswered questions and canned replies, plus staff email alert attempts and unanswered-question counting. The full requested feature set is not complete: PostgreSQL/JSON dual persistence, automated migration, admin settings UI, email test button and hourly digest, dashboard tabs, backup/restore, retention, privacy consent and deletion, full spam controls, guided quote UI, image upload processing, WhatsApp, rating UI and complete feature-specific tests still require implementation and verification. Do not merge or deploy this branch as a completed implementation.

## Go-live checklist

- [ ] Run `npm test` and verify all tests pass.
- [ ] Configure persistent storage and test a restart.
- [ ] Set strong production credentials and secrets.
- [ ] Verify agent/admin permissions and customer chat isolation.
- [ ] Verify backups and perform a restore test.
- [ ] Test chat, handover, document answers and complaint flows on mobile.
- [ ] Verify email delivery with the provider's sandbox/test recipient.
- [ ] Confirm every new feature is implemented and tested before merging.
