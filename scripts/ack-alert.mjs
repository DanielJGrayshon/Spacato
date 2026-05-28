#!/usr/bin/env node
// Acknowledge an open alert via the running Spacato app.
// Usage:  node scripts/ack-alert.mjs <alertId>
// Env:    SPACATO_URL (default: http://localhost:3000)

const raw = process.argv[2];
const alertId = Number.parseInt(raw ?? "", 10);

if (!Number.isInteger(alertId) || alertId <= 0) {
  process.stderr.write("usage: node scripts/ack-alert.mjs <alertId>\n");
  process.stderr.write("  alertId must be a positive integer\n");
  process.exit(1);
}

const base = process.env.SPACATO_URL ?? "http://localhost:3000";
const url = `${base}/api/alerts/acknowledge`;

try {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ alertId }),
  });
  const bodyText = await res.text();
  process.stdout.write(`HTTP ${res.status}\n`);
  process.stdout.write(`${bodyText}\n`);
  process.exit(res.ok ? 0 : 1);
} catch (err) {
  process.stderr.write(`ack-alert: request failed: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
