# Logging: write to stdout, keep user data out

You do not set up log shipping, files, sinks, or agents. Cloud Run captures your container's
**stdout and stderr automatically** and sends them to Cloud Logging; the platform owns
retention (the landing zone sets it on the project `_Default` log bucket). Your only job is
**what** you emit and **how** you shape it.

## The one hard rule: logs are NOT isolated per app

Everything else on the platform is isolated - your app gets its own database, its own DB
user, and per-user row-level security. **Logs are the exception.** Every app's output pools
into the **project-shared `_Default` log bucket**, readable by anyone with project-level log
access. RLS does not apply to logs.

So:

> **Never log user data, PII, secrets, tokens, `DATABASE_URL`, or API keys.**
> Log identifiers and shapes, not values.

This is the same rule as "log the claim KEY NAMES, never the values" in `iap-identity.md`,
generalised. The reason is blast radius: a leaked value in a log line is exposed across the
whole project, not just your app.

## Do

1. **Write to stdout/stderr - never to a log file.** Log files break scale-to-zero
   statelessness and vanish on cold stop anyway. No local logging setup is needed or wanted.
2. **Emit structured single-line JSON**, so Cloud Logging parses it into `jsonPayload`
   instead of storing opaque text. Cloud Logging reads these special keys:
   - `severity` - `DEBUG` / `INFO` / `WARNING` / `ERROR` / `CRITICAL`. Sets the log level so
     you can filter (default to `INFO`; keep `DEBUG` out of the deployed copy).
   - `message` - the human-readable line.
   - `logging.googleapis.com/trace` - set it to the request trace (below) to group every line
     for one request.
   Use a small JSON logger: `pino` (Node), `structlog` or `python-json-logger` (Python).
3. **Correlate by request.** Cloud Run sets the `X-Cloud-Trace-Context` header
   (`TRACE_ID/SPAN_ID;o=1`). Take the `TRACE_ID` part and log it as
   `logging.googleapis.com/trace` = `projects/‹project_id›/traces/‹TRACE_ID›`. Then all of a
   request's logs collapse under one trace in the console.
4. **Send errors to stderr with `severity=ERROR` and a stack trace.** Cloud Run forwards those
   to **Error Reporting** automatically, so you get grouped, alertable errors with no extra
   wiring.
5. **For "which user did this", log the opaque JWT `sub`, not the email.** You already keep
   `sub` "for logging only" (`iap-identity.md`). Because logs sit in the shared bucket, the
   email is PII-in-a-shared-space; the opaque `sub` gives the same traceability without
   spraying addresses across the project. Log the email only as a deliberate choice, never as
   an accidental `console.log(user)`.
6. **Audit privileged actions.** When a user activates break-glass, or performs a cross-user
   write under it (see `shared-db-rls.md`), emit a `WARNING` audit line carrying `event`, the
   actor's `sub`, and the supplied `reason` - but never the row contents. Break-glass is the
   one action that MUST leave a trace; the hard rule above still holds, so log that it
   happened and why, not what the data was.

## Minimal examples

Node (pino), single JSON line with severity + trace:

```js
const logger = require("pino")({
  messageKey: "message",
  formatters: { level: (label) => ({ severity: label.toUpperCase() }) },
});
// per request:
const traceId = (req.header("x-cloud-trace-context") || "").split("/")[0];
logger.info({ "logging.googleapis.com/trace": `projects/${PROJECT_ID}/traces/${traceId}`,
              userSub, event: "campaign.created" }, "created campaign");
```

Python (structlog / json): emit `{"severity": "INFO", "message": "...", "userSub": "...",
"logging.googleapis.com/trace": "projects/.../traces/..."}` as one line to stdout.

## What the platform already gives you (do not rebuild)

- **Transport:** stdout/stderr -> Cloud Logging, automatic. No agent, no config.
- **Request logs:** Cloud Run emits an access log per request (method, path, status, latency)
  on its own. You do not log requests yourself.
- **Retention:** set centrally on the `_Default` bucket by the landing zone (`monitoring.tf`).
- **Error Reporting:** fed automatically from stderr stack traces (see Do #4).

## Note for the operator / roadmap

Log **read** access is project-scoped, so app logs are not isolated the way app data is. If an
app must handle sensitive data, or at the Stage 1->2 promotion, the isolation fix is per-app
**log buckets or log views** with scoped IAM, mirroring the per-app DB model. For Stage 1 the
shared view is acceptable (and useful for central review); it is a later hardening step, not a
blocker.
