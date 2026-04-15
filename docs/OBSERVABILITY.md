# Observability and Alerts

## Logging
- Capture structured logs for auth, billing, ticketing, and webhooks.
- Include event type, org id, actor id, request id, and status.

## Core Alerts
- OTP send failure rate above threshold
- Ticket creation failures
- Billing webhook failures
- Voice webhook signature validation failures

## Dashboards
- API throughput and latency
- Call pipeline events by status
- Billing state distribution (trialing/active/past_due)
- Error rate by endpoint

## SLO Targets
- Ticket creation success: >= 99%
- OTP verification endpoint uptime: >= 99.9%
- Billing webhook processing success: >= 99%
