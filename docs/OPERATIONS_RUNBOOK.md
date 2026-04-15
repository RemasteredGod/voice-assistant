# Operations Runbook

## Health Checks
- API health: `GET /api/stats`
- Auth sanity: `GET /api/auth/me` with session cookie
- Voice webhook: `POST /api/voice` from Twilio with valid signature

## Incident Triage
1. Check process status and restart app if not serving traffic.
2. Review server logs for endpoint and provider errors.
3. Validate Twilio, Stripe, and database connectivity.
4. If database is down, put signup and billing paths in maintenance mode.

## Common Recovery Steps
- **OTP delivery failures**: verify Twilio credentials and sender number.
- **Billing webhook failures**: confirm `STRIPE_WEBHOOK_SECRET` and endpoint path.
- **Database outages**: failover to managed DB backup and re-run health checks.
- **Redis outages**: sessions use fallback cache, then restore Redis quickly.

## Security Response
- Rotate `TWILIO_AUTH_TOKEN`, `GEMINI_API_KEY`, and Stripe keys immediately on suspected leak.
- Invalidate active sessions by clearing Redis keys and `sessions` table.
- Notify affected customers within contractual timelines.
