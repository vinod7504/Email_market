# Email Marketing Tool (MERN)

A MERN-style email marketing app with:
- Excel recipient upload (`.xlsx` / `.xls`)
- Sender account connection via Google OAuth or custom SMTP (any domain email)
- Subject + body composer
- OpenAI spam meter based on typed subject
- Campaign scheduling and immediate send
- Open tracking using pixel URL (works with ngrok/public URL)
- Dashboard with campaign and recipient statuses

## Tech Stack
- MongoDB + Mongoose
- Express + Node.js
- React (Vite + React Router)
- Google Gmail API (`googleapis`)
- SMTP sending (`nodemailer`)
- Excel parsing (`xlsx`)

## 1. Setup

```bash
npm install
npm run install:all
cp backend/.env.example backend/.env
```

Fill `backend/.env` values:
- `MONGO_URI` (local or Atlas connection string)
- `CLIENT_URL` (local client: `http://localhost:5173`)
- `OPENAI_API_KEY`
- `OPENAI_MODEL` (`gpt-4o-mini` default)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (local use: `http://localhost:3000/auth/google/callback`)
- `PUBLIC_BASE_URL` (can be replaced in UI with ngrok URL)

## 2. Configure Sender Connection

You can use either option:

1. Google OAuth (Gmail API)
2. Custom SMTP (domain emails like `@deepdrishti.ai`, `@avanceepro.ai`, etc.)

### Google OAuth (optional)

In Google Cloud Console:
1. Create a project (or use existing).
2. Enable Gmail API.
3. Create OAuth 2.0 Client ID (`Web application`).
4. Add authorized redirect URI:
   - `http://localhost:3000/auth/google/callback`
5. Copy client ID and secret into `backend/.env`.

### Custom SMTP

From your email provider, collect:
- SMTP host
- SMTP port (usually `465` SSL/TLS or `587` STARTTLS)
- SMTP username
- SMTP password or app password

## 3. Start App (Server + React Client)

```bash
npm run dev
```

Open:
- Upload page: `http://localhost:5173/upload`
- Template page: `http://localhost:5173/compose`
- Dashboard: `http://localhost:5173/dashboard`
- API health: `http://localhost:3000/health`

## 4. Use ngrok for Open Tracking

Tracking pixel must be publicly reachable.

```bash
ngrok config add-authtoken <YOUR_NGROK_AUTHTOKEN>
ngrok http 3000
```

Copy the HTTPS ngrok URL and paste it into:
- `Template & Send` page
- `Public Base URL (ngrok)` field

Saved URL becomes the base for tracking pixels:
- `/track/open/:token.gif`

## 5. Campaign Workflow

1. Open upload page and connect sender account first (Google or SMTP).
2. Upload Excel sheet with recipient emails.
3. Continue to template page and enter subject, body, signature.
4. View OpenAI-powered subject spam meter score and reasons.
5. Click `Send Campaign` (or `Schedule Campaign`) to send the exact subject/body/signature you entered.
6. App redirects to dashboard automatically.
7. Track sent/opened status in dashboard and recipient list.

## Notes
- This app uses one active sender account at a time, but supports switching among connected accounts.
- Open tracking is best-effort. Some email clients block tracking pixels.
- Campaign and recipient data are stored in MongoDB.

## Folder Structure

- `backend/` Express API, Mongo/Mongoose models, scheduler, OAuth and send tracking
- `frontend/` React app (Vite) with upload, template + send, and dashboard pages
