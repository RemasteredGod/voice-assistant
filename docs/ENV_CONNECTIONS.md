# Environment Connections Checklist

Use this file as your single source for configuring `.env` before launch.

## 1) Copy base file

From project root:

```bash
cp .env.example .env
```

Then open `.env` and fill these values.

## 2) Required for app boot

```env
PORT=3000
APP_NAME=CallPilot AI
BASE_URL=http://localhost:3000
PUBLIC_APP_ORIGIN=http://localhost:3000
ALLOWED_ORIGINS=http://localhost:3000
```

## 3) AI + phone (core product)

```env
GEMINI_API_KEY=your-gemini-key
GOOGLE_APPLICATION_CREDENTIALS=./google-credentials.json

TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx
```

## 4) Auth email OTP (admin login)

```env
EMAIL_USER=your-gmail@gmail.com
EMAIL_PASS=your-gmail-app-password
ADMIN_EMAILS=owner@yourdomain.com,ops@yourdomain.com
```

## 5) Persistence (recommended for real usage)

```env
DATABASE_URL=postgres://postgres:postgres@localhost:5432/callpilot
PG_SSL=false
REDIS_URL=redis://localhost:6379
```

## 6) Billing (Stripe test mode first)

```env
STRIPE_SECRET_KEY=sk_test_xxxxxxxxxxxxxxxxxxxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxxxxxxxxxxxxxxxxxxx
STRIPE_PRICE_STARTER=price_xxxxxxxxxxxxxxxxxxxxx
STRIPE_PRICE_PROFESSIONAL=price_xxxxxxxxxxxxxxxxxxxxx
STRIPE_PRICE_GROWTH=price_xxxxxxxxxxxxxxxxxxxxx
```

Notes:
- Use `sk_test_...` for development.
- Keep `pk_test_...` only for frontend Stripe Elements (not currently required by backend checkout endpoint).

## 7) Upload storage mode

### Local (default)

```env
STORAGE_PROVIDER=local
```

### S3-compatible (production)

```env
STORAGE_PROVIDER=s3
S3_BUCKET=callpilot-uploads
S3_REGION=us-east-1
S3_ENDPOINT=
S3_ACCESS_KEY_ID=xxxxxxxx
S3_SECRET_ACCESS_KEY=xxxxxxxx
```

## 8) Observability

```env
SENTRY_DSN=
SENTRY_TRACES_SAMPLE_RATE=0
```

## 9) Quick verification after saving `.env`

Run:

```bash
npm run lint
npm test
npm start
```

Then check:
- `http://localhost:3000/api/health`
- `http://localhost:3000/signup`
- `http://localhost:3000/pricing`

## 10) Security reminder

- Never commit `.env` or credential JSON files.
- Rotate keys if they were shared in chat/screenshots.
