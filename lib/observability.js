const Sentry = require('@sentry/node');

const sentryDsn = process.env.SENTRY_DSN || '';
const sentryEnabled = Boolean(sentryDsn);

const metrics = {
  requestsTotal: 0,
  errorsTotal: 0,
  authFailures: 0,
  ticketCreates: 0,
  uploadFailures: 0,
  billingFailures: 0,
  startedAt: new Date().toISOString(),
};

if (sentryEnabled) {
  Sentry.init({
    dsn: sentryDsn,
    environment: process.env.NODE_ENV || 'development',
    tracesSampleRate: Number(process.env.SENTRY_TRACES_SAMPLE_RATE || 0),
  });
}

function increment(metricName, value = 1) {
  if (metrics[metricName] === undefined) return;
  metrics[metricName] += value;
}

function captureError(error, context = {}) {
  metrics.errorsTotal += 1;
  if (sentryEnabled) {
    Sentry.captureException(error, { extra: context });
  } else {
    console.error('[OBSERVE]', error.message, context);
  }
}

function getMetricsSnapshot() {
  return { ...metrics, sentryEnabled };
}

module.exports = {
  captureError,
  getMetricsSnapshot,
  increment,
  sentryEnabled,
};
