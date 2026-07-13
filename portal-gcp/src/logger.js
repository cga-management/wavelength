// Structured single-line JSON logs to stdout (skills/onboard-app/references/logging.md).
// Cloud Run captures stdout -> Cloud Logging. The one hard rule: logs are NOT isolated
// per app, so NEVER log user data, emails, secrets, tokens, or DATABASE_URL. Log
// identifiers and shapes (the opaque JWT `sub`, event names, ids) - never values.

const PROJECT_ID = process.env.GCP_PROJECT_ID || "";

function emit(severity, message, fields = {}) {
  const entry = { severity, message, ...fields };
  const trace = fields.traceId;
  if (trace && PROJECT_ID) {
    entry["logging.googleapis.com/trace"] = `projects/${PROJECT_ID}/traces/${trace}`;
    delete entry.traceId;
  }
  // One line so Cloud Logging parses it into jsonPayload.
  process.stdout.write(JSON.stringify(entry) + "\n");
}

export const log = {
  debug: (message, fields) => emit("DEBUG", message, fields),
  info: (message, fields) => emit("INFO", message, fields),
  warning: (message, fields) => emit("WARNING", message, fields),
  error: (message, fields) => {
    // Errors to stderr with a stack are forwarded to Error Reporting automatically.
    const entry = { severity: "ERROR", message, ...fields };
    process.stderr.write(JSON.stringify(entry) + "\n");
  },
};

// Extract the Cloud Trace id from the request header so all lines for one request group.
export function traceOf(req) {
  return (req.headers["x-cloud-trace-context"] || "").split("/")[0] || undefined;
}
