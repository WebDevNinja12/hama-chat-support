# Hama Enterprise Ng — Live Chat Support

Node.js + Express + Socket.io chat for **Hama Enterprise Ng** (RC 8827959): painting, interior and exterior design.

## Features

- Customer widget (name + phone/email, privacy consent, quick replies)
- Bot answers from admin Q&A + uploaded documents (optional Anthropic AI)
- Agent dashboard (take over, notes, resolve)
- Documents library, editable AI instructions
- Privacy guard (cards / passwords masked)
- Complaint handling + honest offline handover
- Staff email alerts (Resend or Brevo over HTTPS)
- Call-back list when no agent is online
- Quote request flow → leads (no prices in chat)
- Ratings after resolve
- Spam protection (honeypot, rate limits, blocks)
- Backup / CSV export
- WhatsApp button (admin-configured)

## Quick start

```bash
npm install
cp .env.example .env   # set JWT_SECRET
npm start
```

- Dashboard: http://localhost:3000/dashboard  
- Widget demo: http://localhost:3000/widget-demo.html  
- Default admin: `admin` / `hama123` (change after login)

## Environment variables

| Variable | Purpose |
|----------|---------|
| `PORT` | Server port (default 3000) |
| `JWT_SECRET` | Required for agent login tokens |
| `DATA_DIR` | Folder for SQLite DB, uploads, instructions (use `/var/data` on Render disk) |
| `ADMIN_PASSWORD` | Initial admin password when DB is empty |
| `ANTHROPIC_API_KEY` | Optional AI-written replies |
| `ANTHROPIC_MODEL` | Optional model id |
| `AI_DAILY_LIMIT` | Max AI replies per day (default 300) |
| `DATABASE_URL` | Optional Postgres URL (Neon/Supabase). App still uses SQLite in `DATA_DIR` by default for free Render; point a disk at `DATA_DIR` or use external Postgres for durability. |
| `EMAIL_PROVIDER` | `resend` (default) or `brevo` |
| `EMAIL_API_KEY` | API key for email provider |
| `EMAIL_FROM` | From address |
| `ALERT_EMAILS` | Comma-separated staff emails |
| `PUBLIC_URL` | Public site URL (for links in alerts) |
| `WHATSAPP_TOKEN` / `WHATSAPP_TO` / `WHATSAPP_PHONE_ID` | Optional WhatsApp Cloud alerts |
| `CHAT_RETENTION_DAYS` | Auto-delete chats older than N days (0 = keep) |
| `MAX_MESSAGE_LENGTH` | Default 2000 |
| `MAX_CHATS_PER_IP_HOUR` | Default 10 |

### Free Render + durable data

Render free disks are limited; free Render Postgres expires after ~30 days.

1. **Recommended on free tier:** attach a **persistent disk** and set `DATA_DIR=/var/data`.  
2. **Or** create a free **Neon** or **Supabase** Postgres and set `DATABASE_URL` (keep backups).  
3. Set `PUBLIC_URL` to your Render URL for alert links.

### Email alerts (no SMTP)

Free Render blocks SMTP ports. Use Resend or Brevo HTTPS APIs:

```
EMAIL_PROVIDER=resend
EMAIL_API_KEY=re_xxx
EMAIL_FROM=Support <you@yourdomain.com>
ALERT_EMAILS=you@company.com,other@company.com
PUBLIC_URL=https://your-app.onrender.com
```

Admin → Settings → **Send test alert** (API: `POST /api/ops/alerts/test`).

## Admin privacy / WhatsApp settings

Store via `PUT /api/admin/settings`:

- `privacy_text`, `privacy_url`
- `whatsapp_number` (digits / international), `whatsapp_prefill`
- `uploads_enabled` (`0` or `1`)

## Tests

```bash
npm test
```

## Go-live checklist

1. Set strong `JWT_SECRET` and change admin password  
2. Set `DATA_DIR` on a disk (or external DB strategy)  
3. Configure `ALERT_EMAILS` + email API  
4. Add Q&A and/or Documents content  
5. Set privacy text/URL  
6. Embed `<script src="https://YOUR_HOST/widget.js"></script>`  
7. Test: quote flow, offline call-back, complaint, privacy tick  
