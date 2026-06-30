import fs from "fs";
import path from "path";

const FILES = {
  "backend/.env.example": `# ── Sarvam AI ──────────────────────────────────────────────────────────────────
# Get from: dashboard.sarvam.ai → API Keys
SARVAM_API_KEY=your_sarvam_key_here

# ── Tanla (WhatsApp voice broadcast) ──────────────────────────────────────────
# Get from: Tanla portal → API credentials
TANLA_ACCESS_KEY=your_tanla_key_here
TANLA_DID=919010082954
TANLA_USERNAME=Meesho

# ── Twilio (Interactive voice bot — live audio stream) ────────────────────────
# Sign up free at twilio.com — $15 trial credit included
# Get from: console.twilio.com → Account Info
TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_PHONE_NUMBER=+1xxxxxxxxxx

# ── Backend public URL (required for Twilio webhooks) ─────────────────────────
# After deploying to Render, set this to your Render URL
# For local dev, use ngrok: ngrok http 3001  → paste the https URL here
BACKEND_URL=https://meesho-voice-api.onrender.com

# ── Frontend ───────────────────────────────────────────────────────────────────
FRONTEND_URL=https://aihub4u.github.io

# ── Server ────────────────────────────────────────────────────────────────────
PORT=3001

# ── Exotel (Interactive voice bot — Indian outbound calls) ────────────────────
# Sign up at exotel.com → API Credentials page
EXOTEL_ACCOUNT_SID=your_exotel_account_sid
EXOTEL_API_KEY=your_exotel_api_key
EXOTEL_API_TOKEN=your_exotel_api_token
EXOTEL_PHONE_NUMBER=08047285770
EXOTEL_SUBDOMAIN=api.in.exotel.com
`,
  "backend/package.json": `{
  "name": "meesho-voice-backend",
  "version": "2.0.0",
  "description": "Meesho voice campaign backend \\u2014 Sarvam AI TTS + Tanla outbound calls",
  "main": "src/server.js",
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "dev": "node --watch src/server.js"
  },
  "dependencies": {
    "express": "^4.18.2",
    "cors": "^2.8.5",
    "dotenv": "^16.3.1",
    "node-fetch": "^3.3.2",
    "form-data": "^4.0.0",
    "multer": "^1.4.5-lts.1",
    "csv-parse": "^5.5.3",
    "express-rate-limit": "^7.1.5",
    "ws": "^8.16.0",
    "twilio": "^5.3.0"
  }
}`,
  "backend/src/routes/campaign.js": `import express from "express";
import { generateSpeech } from "../services/sarvam.js";
import { dispatchCall }   from "../services/tanla.js";

const router = express.Router();

// In-memory campaign store — keyed by campaignId
// Replace with a DB (Supabase free tier) for multi-server production use
const campaigns = new Map();

// ── Helpers ─────────────────────────────────────────────────────────────────

function interpolate(template, row) {
  return template.replace(/\\{(\\w+)\\}/g, (_, k) => row[k] || \`{\${k}}\`);
}

function buildSingleRowCSV(headers, row) {
  const vals = headers.map(h => {
    const v = String(row[h] || "");
    return v.includes(",") ? \`"\${v}"\` : v;
  });
  return headers.join(",") + "\\n" + vals.join(",");
}

function broadcast(campaign, event, data) {
  for (const send of (campaign._clients || [])) {
    try { send(event, data); } catch (_) {}
  }
}

function log(campaign, msg, type = "info") {
  const entry = { msg, type, ts: new Date().toLocaleTimeString("en-IN") };
  campaign.logs.push(entry);
  broadcast(campaign, "log", entry);
}

// ── POST /api/campaign/start ─────────────────────────────────────────────────
//
// Body (JSON):
//   rows        — array of contact objects from parsed CSV
//   headers     — CSV column names in order
//   script      — template string e.g. "Hi {customer_name}…"
//   speaker     — Sarvam voice id e.g. "priya"
//   sampleRate  — 8000 | 16000 | 22050 | 24000
//
// Returns: { campaignId, total }
// Frontend then connects to GET /api/campaign/:id/progress (SSE)

router.post("/start", async (req, res, next) => {
  try {
    const { rows, headers, script, speaker = "priya", sampleRate = 8000 } = req.body;

    if (!rows?.length)   return res.status(400).json({ error: "No rows provided" });
    if (!script?.trim()) return res.status(400).json({ error: "Script template required" });
    if (!headers?.length) return res.status(400).json({ error: "CSV headers required" });

    const campaignId = \`camp_\${Date.now()}_\${Math.random().toString(36).slice(2,7)}\`;

    campaigns.set(campaignId, {
      id: campaignId,
      rows: rows.map((r, i) => ({ ...r, _i: i, _status: "pending" })),
      headers,
      script,
      speaker,
      sampleRate,
      status: "running",
      logs: [],
      stats: { total: rows.length, audioOk: 0, dispatched: 0, audioErr: 0, callErr: 0 },
      _clients: [],
    });

    res.json({ campaignId, total: rows.length });

    // Run in background — non-blocking
    runCampaign(campaignId).catch(err =>
      console.error(\`[Campaign \${campaignId}] fatal:\`, err.message)
    );
  } catch (err) { next(err); }
});

// ── GET /api/campaign/:id/progress  (Server-Sent Events) ────────────────────

router.get("/:id/progress", (req, res) => {
  const campaign = campaigns.get(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });

  res.setHeader("Content-Type",  "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection",    "keep-alive");
  res.flushHeaders();

  const send = (event, data) =>
    res.write(\`event: \${event}\\ndata: \${JSON.stringify(data)}\\n\\n\`);

  // Immediately send current state
  send("snapshot", {
    rows:   campaign.rows,
    logs:   campaign.logs,
    stats:  campaign.stats,
    status: campaign.status,
  });

  campaign._clients.push(send);
  req.on("close", () => {
    campaign._clients = campaign._clients.filter(c => c !== send);
  });
});

// ── GET /api/campaign/:id  (polling fallback) ────────────────────────────────

router.get("/:id", (req, res) => {
  const campaign = campaigns.get(req.params.id);
  if (!campaign) return res.status(404).json({ error: "Campaign not found" });
  const { _clients, ...safe } = campaign;
  res.json(safe);
});

// ── Core campaign runner ─────────────────────────────────────────────────────

async function runCampaign(campaignId) {
  const camp = campaigns.get(campaignId);
  if (!camp) return;

  const { rows, headers, script, speaker, sampleRate } = camp;
  const hasTanla = !!(process.env.TANLA_ACCESS_KEY && process.env.TANLA_DID);

  log(camp, \`🚀 Campaign started — \${rows.length} contacts | voice: \${speaker} | \${sampleRate}Hz\`, "info");
  if (!hasTanla) log(camp, "⚠ Tanla keys not set — audio only mode (no calls dispatched)", "warn");

  for (let i = 0; i < rows.length; i++) {
    const row  = rows[i];
    const text = interpolate(script, row);

    // ── Phase 1: Sarvam TTS ────────────────────────────────────────────────
    row._status = "generating";
    broadcast(camp, "row_update", { i, status: "generating" });
    log(camp, \`[\${row.customer_name || row.phone_number}] Generating audio…\`);

    let audioBuffer;
    try {
      audioBuffer = await generateSpeech({ text, speaker, sampleRate });
      row._status = "audio_ready";
      broadcast(camp, "row_update", { i, status: "audio_ready" });
      log(camp, \`[\${row.customer_name || row.phone_number}] ✓ Audio ready (\${(audioBuffer.length/1024).toFixed(0)}KB)\`, "success");
      camp.stats.audioOk++;

    } catch (e) {
      row._status = "audio_err";
      row._error  = e.message;
      broadcast(camp, "row_update", { i, status: "audio_err", error: e.message });
      log(camp, \`[\${row.customer_name || row.phone_number}] Audio failed: \${e.message}\`, "error");
      camp.stats.audioErr++;
      broadcast(camp, "stats", camp.stats);
      await delay(300);
      continue; // skip Tanla for this row
    }

    // ── Phase 2: Tanla dispatch ────────────────────────────────────────────
    if (hasTanla) {
      row._status = "dispatching";
      broadcast(camp, "row_update", { i, status: "dispatching" });
      log(camp, \`[\${row.customer_name || row.phone_number}] Dispatching via Tanla…\`);

      try {
        const csvContent = buildSingleRowCSV(headers, row);
        const safeName   = (row.customer_name || row.phone_number || \`contact_\${i}\`)
                             .replace(/[^a-zA-Z0-9_]/g, "_");
        const audioName  = \`\${safeName}_\${row.phone_number}.wav\`;

        await dispatchCall({
          phone: row.phone_number,
          csvContent,
          audioBuffer,
          audioName,
        });

        row._status = "dispatched";
        broadcast(camp, "row_update", { i, status: "dispatched" });
        log(camp, \`[\${row.customer_name || row.phone_number}] ✓ Call dispatched\`, "success");
        camp.stats.dispatched++;

      } catch (e) {
        row._status = "call_err";
        row._error  = e.message;
        broadcast(camp, "row_update", { i, status: "call_err", error: e.message });
        log(camp, \`[\${row.customer_name || row.phone_number}] Call failed: \${e.message}\`, "error");
        camp.stats.callErr++;
      }
    } else {
      // Audio-only mode
      row._status = "audio_ready";
      camp.stats.dispatched++;
    }

    broadcast(camp, "stats", camp.stats);
    // 500ms gap between contacts — avoid hammering Sarvam + Tanla
    if (i < rows.length - 1) await delay(500);
  }

  camp.status = "complete";
  log(camp, \`✅ Campaign complete | dispatched: \${camp.stats.dispatched} | errors: \${camp.stats.audioErr + camp.stats.callErr}\`, "success");
  broadcast(camp, "complete", camp.stats);
}

const delay = ms => new Promise(r => setTimeout(r, ms));

export default router;
`,
  "backend/src/routes/tts.js": `import express from "express";
import { generateSpeech } from "../services/sarvam.js";

const router = express.Router();

/**
 * POST /api/tts/preview
 * Body: { text, speaker, sampleRate }
 * Returns: { audioBase64, byteSize }
 * Used by the Voice Tester tab in the browser.
 */
router.post("/preview", async (req, res, next) => {
  try {
    const { text, speaker = "priya", sampleRate = 8000 } = req.body;

    if (!text?.trim())       return res.status(400).json({ error: "text is required" });
    if (text.length > 2500)  return res.status(400).json({ error: "Text exceeds 2500 char limit" });

    const buf = await generateSpeech({ text, speaker, sampleRate });
    res.json({ audioBase64: buf.toString("base64"), byteSize: buf.length });

  } catch (err) { next(err); }
});

export default router;
`,
  "backend/src/routes/upload.js": `import express from "express";
import multer from "multer";
import { parseCSVBuffer } from "../utils/csv.js";

const router = express.Router();

// Store file in memory (no disk write needed — parse immediately)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB max
  fileFilter: (_, file, cb) => {
    if (file.mimetype === "text/csv" || file.originalname.endsWith(".csv")) {
      cb(null, true);
    } else {
      cb(new Error("Only CSV files are supported"));
    }
  },
});

/**
 * POST /api/upload/csv
 * Body: multipart/form-data  field: "file"
 * Returns: { rows, headers, errors, total }
 */
router.post("/csv", upload.single("file"), (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file uploaded" });

    const { rows, errors, headers } = parseCSVBuffer(req.file.buffer);

    console.log(\`[Upload] CSV parsed | rows=\${rows.length} | errors=\${errors.length}\`);

    res.json({
      total:   rows.length,
      headers,
      rows,
      errors,
      hasErrors: errors.length > 0,
    });
  } catch (err) {
    next(err);
  }
});

export default router;
`,
  "backend/src/server.js": `import "dotenv/config";
import http           from "http";
import express        from "express";
import cors           from "cors";
import rateLimit      from "express-rate-limit";
import uploadRouter   from "./routes/upload.js";
import campaignRouter from "./routes/campaign.js";
import ttsRouter      from "./routes/tts.js";
import voicebotRouter, { attachWebSocket, getFlows } from "./voicebot/routes.js";
import twilioRouter,   { attachTwilioWebSocket, initTwilio } from "./voicebot/twilioRoutes.js";
import exotelRouter,   { attachExotelWebSocket, initExotel } from "./voicebot/exotelRoutes.js";

const app    = express();
const server = http.createServer(app);
const PORT   = process.env.PORT || 3001;

const allowed = [
  process.env.FRONTEND_URL,
  "http://localhost:5173",
  "http://localhost:3000",
].filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin || origin === "null" || allowed.includes(origin)) return cb(null, true);
    if (/\\.github\\.io$/.test(origin)) return cb(null, true);
    cb(new Error(\`CORS blocked: \${origin}\`));
  },
  credentials: true,
}));

app.use("/api/twilio/status",  express.urlencoded({ extended: false }));
app.use("/api/twilio/twiml",   express.urlencoded({ extended: false }));
app.use("/api/exotel/status",  express.urlencoded({ extended: false }));
app.use(express.json({ limit: "10mb" }));
app.use(rateLimit({ windowMs: 15*60*1000, max: 300, message: { error: "Rate limited" } }));

app.use("/api/upload",    uploadRouter);
app.use("/api/campaign",  campaignRouter);
app.use("/api/tts",       ttsRouter);
app.use("/api/voicebot",  voicebotRouter);
app.use("/api/twilio",    twilioRouter);
app.use("/api/exotel",    exotelRouter);

app.get("/health", (_, res) => res.json({
  status: "ok",
  timestamp: new Date().toISOString(),
  env: {
    sarvam: !!process.env.SARVAM_API_KEY,
    tanla:  !!(process.env.TANLA_ACCESS_KEY && process.env.TANLA_DID),
    twilio: !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN),
    exotel: !!(process.env.EXOTEL_ACCOUNT_SID && process.env.EXOTEL_API_KEY),
  },
}));

app.use((err, _req, res, _next) => {
  console.error("[ERROR]", err.message);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const flows = getFlows();
initTwilio(flows);
initExotel(flows);
attachWebSocket(server);
attachTwilioWebSocket(server);
attachExotelWebSocket(server);

server.listen(PORT, () => {
  console.log(\`\\n🚀 Meesho Voice Platform → http://localhost:\${PORT}\`);
  console.log(\`   Sarvam  : \${process.env.SARVAM_API_KEY       ? "✓" : "✗ missing"}\`);
  console.log(\`   Tanla   : \${process.env.TANLA_ACCESS_KEY      ? "✓" : "✗ missing"}\`);
  console.log(\`   Twilio  : \${process.env.TWILIO_ACCOUNT_SID    ? "✓" : "✗ missing"}\`);
  console.log(\`   Exotel  : \${process.env.EXOTEL_ACCOUNT_SID    ? "✓" : "✗ missing"}\`);
  console.log(\`   WS bot  : ws://localhost:\${PORT}/ws/voicebot\`);
  console.log(\`   WS TW   : ws://localhost:\${PORT}/ws/twilio\`);
  console.log(\`   WS EX   : ws://localhost:\${PORT}/ws/exotel\`);
  console.log(\`   Frontend: \${process.env.FRONTEND_URL || "http://localhost:5173"}\\n\`);
});
`,
  "backend/src/services/sarvam.js": `import fetch from "node-fetch";

const SARVAM_TTS_URL = "https://api.sarvam.ai/text-to-speech";

const LANG_CODE = {
  shubh:"hi-IN", aditya:"hi-IN", rahul:"hi-IN", rohan:"hi-IN",
  amit:"hi-IN",  dev:"hi-IN",    ratan:"hi-IN",  varun:"hi-IN",
  manan:"hi-IN", sumit:"hi-IN",  kabir:"hi-IN",  aayan:"hi-IN",
  ashutosh:"hi-IN", advait:"hi-IN", anand:"hi-IN", tarun:"hi-IN",
  sunny:"hi-IN", mani:"hi-IN",   gokul:"hi-IN",  vijay:"hi-IN",
  mohit:"hi-IN", rehan:"hi-IN",  soham:"hi-IN",
  ritu:"hi-IN",  priya:"hi-IN",  neha:"hi-IN",   pooja:"hi-IN",
  simran:"hi-IN",kavya:"hi-IN",  ishita:"hi-IN", shreya:"hi-IN",
  roopa:"hi-IN", tanya:"hi-IN",  shruti:"hi-IN", suhani:"hi-IN",
  kavitha:"hi-IN", rupali:"hi-IN",
};

/**
 * Generate speech audio using Sarvam AI bulbul:v3
 * @param {string} text         - Personalised script for this contact
 * @param {string} speaker      - Voice ID e.g. "priya"
 * @param {number} sampleRate   - 8000 | 16000 | 22050 | 24000
 * @returns {Buffer}            - WAV audio buffer
 */
export async function generateSpeech({ text, speaker = "priya", sampleRate = 8000 }) {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("SARVAM_API_KEY not configured");

  const payload = {
    inputs: [text],
    target_language_code: LANG_CODE[speaker] || "hi-IN",
    speaker,
    speech_sample_rate: sampleRate,
    model: "bulbul:v3",
  };

  console.log(\`[Sarvam] TTS | speaker=\${speaker} | rate=\${sampleRate} | chars=\${text.length}\`);

  const res = await fetch(SARVAM_TTS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-subscription-key": apiKey,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(\`Sarvam \${res.status}: \${err.message || err.detail || JSON.stringify(err)}\`);
  }

  const data = await res.json();
  const b64 = data.audios?.[0];
  if (!b64) throw new Error("Sarvam returned empty audio");

  const buf = Buffer.from(b64, "base64");
  console.log(\`[Sarvam] ✓ \${(buf.length / 1024).toFixed(1)}KB\`);
  return buf;
}
`,
  "backend/src/services/tanla.js": `import fetch from "node-fetch";
import FormData from "form-data";

const TANLA_URL = "https://hvms1.tanla.com/upload";

/**
 * Dispatch a personalised voice call via Tanla
 *
 * Tanla's API accepts a multipart POST with:
 *   access_key  — your Tanla API key
 *   csv         — single-row CSV (just this one contact)
 *   audio       — the personalised WAV file for this contact
 *   username    — your Tanla account username
 *   DID         — caller ID number registered in Tanla
 *
 * Running server-side on Render means no CORS issues.
 *
 * @param {object} opts
 * @param {string} opts.phone        - E.164 phone number
 * @param {string} opts.csvContent   - Single-row CSV string for this contact
 * @param {Buffer} opts.audioBuffer  - WAV audio for this contact
 * @param {string} opts.audioName    - Filename for the WAV e.g. "riya_sharma.wav"
 * @returns {string}                 - Tanla response text
 */
export async function dispatchCall({ phone, csvContent, audioBuffer, audioName }) {
  const accessKey = process.env.TANLA_ACCESS_KEY;
  const did       = process.env.TANLA_DID;
  const username  = process.env.TANLA_USERNAME;

  if (!accessKey) throw new Error("TANLA_ACCESS_KEY not configured");
  if (!did)       throw new Error("TANLA_DID not configured");
  if (!username)  throw new Error("TANLA_USERNAME not configured");

  const form = new FormData();
  form.append("access_key", accessKey);
  form.append("username",   username);
  form.append("DID",        did);
  form.append("csv",        Buffer.from(csvContent), {
    filename:    "contacts.csv",
    contentType: "text/csv",
  });
  form.append("audio", audioBuffer, {
    filename:    audioName,
    contentType: "audio/wav",
  });

  console.log(\`[Tanla] Dispatching call | to=\${phone} | audio=\${audioName} | csv_bytes=\${csvContent.length}\`);

  const res = await fetch(TANLA_URL, {
    method:  "POST",
    body:    form,
    headers: form.getHeaders(),
    timeout: 30000,
  });

  const text = await res.text().catch(() => "");

  if (!res.ok) {
    throw new Error(\`Tanla \${res.status}: \${text.slice(0, 120)}\`);
  }

  console.log(\`[Tanla] ✓ Dispatched | to=\${phone} | response=\${text.slice(0, 80)}\`);
  return text;
}
`,
  "backend/src/utils/csv.js": `import { parse } from "csv-parse/sync";

const REQUIRED_COLS = ["customer_name", "phone_number", "store_name", "pickup_timings"];
const PHONE_RE = /^\\+\\d{10,15}$/;

/**
 * Parse a CSV buffer and return validated rows
 * @param {Buffer|string} input
 * @returns {{ rows: object[], errors: string[], headers: string[] }}
 */
export function parseCSVBuffer(input) {
  let records;
  try {
    records = parse(input, {
      columns: true,        // first row as header
      skip_empty_lines: true,
      trim: true,
    });
  } catch (e) {
    return { rows: [], errors: [\`CSV parse error: \${e.message}\`], headers: [] };
  }

  if (!records.length) {
    return { rows: [], errors: ["File is empty or has no data rows"], headers: [] };
  }

  const headers = Object.keys(records[0]);
  const missing = REQUIRED_COLS.filter(c => !headers.includes(c));
  const errors = missing.length ? [\`Missing required columns: \${missing.join(", ")}\`] : [];

  const rows = records.map((row, i) => {
    const rowNum = i + 2; // 1-indexed + header row
    if (!PHONE_RE.test(row.phone_number)) {
      errors.push(\`Row \${rowNum}: invalid phone "\${row.phone_number}" — must be E.164 e.g. +919876543210\`);
    }
    if (!row.customer_name?.trim()) {
      errors.push(\`Row \${rowNum}: customer_name is empty\`);
    }
    return { ...row, _rowNum: rowNum };
  });

  return { rows, errors, headers };
}

/**
 * Interpolate {variable} placeholders in a script template
 */
export function interpolate(template, row) {
  return template.replace(/\\{(\\w+)\\}/g, (_, key) => row[key] || \`{\${key}}\`);
}

/**
 * Check if current time is within allowed call window
 */
export function isWithinCallWindow() {
  const now = new Date();
  const [startH, startM] = (process.env.CALL_WINDOW_START || "09:00").split(":").map(Number);
  const [endH,   endM]   = (process.env.CALL_WINDOW_END   || "21:00").split(":").map(Number);
  const nowMins  = now.getHours() * 60 + now.getMinutes();
  const startMin = startH * 60 + startM;
  const endMin   = endH   * 60 + endM;
  return nowMins >= startMin && nowMins <= endMin;
}
`,
  "backend/src/voicebot/exotelRoutes.js": `import express            from "express";
import fetch              from "node-fetch";
import FormData           from "form-data";
import { WebSocketServer } from "ws";
import { ExotelSession }  from "./exotelSession.js";

const router   = express.Router();
const sessions = new Map();  // callSid → ExotelSession

let flows = null;
export function initExotel(flowStore) { flows = flowStore; }

// ── Exotel API helper ────────────────────────────────────────────────────────
function getExotelConfig() {
  const accountSid = process.env.EXOTEL_ACCOUNT_SID;
  const apiKey     = process.env.EXOTEL_API_KEY;
  const apiToken   = process.env.EXOTEL_API_TOKEN;
  const subdomain  = process.env.EXOTEL_SUBDOMAIN || "api.in.exotel.com";

  if (!accountSid || !apiKey || !apiToken) {
    throw new Error("EXOTEL_ACCOUNT_SID / EXOTEL_API_KEY / EXOTEL_API_TOKEN not set");
  }
  return { accountSid, apiKey, apiToken, subdomain };
}

// ── POST /api/exotel/call ─────────────────────────────────────────────────────
// Trigger an outbound call. Body: { to, flowId, variables }
router.post("/call", async (req, res, next) => {
  try {
    const { to, flowId = "meesho-pickup", variables = {} } = req.body;
    if (!to) return res.status(400).json({ error: "to (phone number) required" });

    const flow = flows?.get(flowId);
    if (!flow) return res.status(404).json({ error: \`Flow "\${flowId}" not found\` });

    const { accountSid, apiKey, apiToken, subdomain } = getExotelConfig();
    const backendUrl = process.env.BACKEND_URL || \`https://\${req.headers.host}\`;
    const exophone   = process.env.EXOTEL_PHONE_NUMBER;

    if (!exophone) return res.status(400).json({ error: "EXOTEL_PHONE_NUMBER not set" });

    // Encode variables for passing to WebSocket
    const varsB64  = Buffer.from(JSON.stringify({ ...variables, flowId })).toString("base64");
    const streamUrl = \`\${backendUrl.replace(/^https?/, "wss")}/ws/exotel?vars=\${encodeURIComponent(varsB64)}\`;

    // Exotel outbound call with AgentStream (bidirectional WebSocket)
    const form = new FormData();
    form.append("From",           to);
    form.append("CallerId",       exophone);
    form.append("Url",            \`\${backendUrl}/api/exotel/applet?flowId=\${flowId}&vars=\${encodeURIComponent(varsB64)}\`);
    form.append("StatusCallback", \`\${backendUrl}/api/exotel/status\`);
    form.append("StatusCallbackEvents[0]", "terminal");

    const url  = \`https://\${subdomain}/v1/Accounts/\${accountSid}/Calls/connect\`;
    const auth = Buffer.from(\`\${apiKey}:\${apiToken}\`).toString("base64");

    console.log(\`[Exotel] Outbound call | to=\${to} | flow=\${flowId}\`);

    const resp = await fetch(url, {
      method:  "POST",
      body:    form,
      headers: { ...form.getHeaders(), Authorization: \`Basic \${auth}\` },
    });

    const data = await resp.json().catch(() => ({}));

    if (!resp.ok) {
      throw new Error(\`Exotel \${resp.status}: \${JSON.stringify(data)}\`);
    }

    const callSid = data.Call?.Sid || data.call?.sid;
    console.log(\`[Exotel] ✓ Call initiated | sid=\${callSid}\`);
    res.json({ callSid, status: data.Call?.Status || "queued", to, flowId });

  } catch (e) { next(e); }
});

// ── GET /api/exotel/trigger ───────────────────────────────────────────────────
// Browser-friendly GET endpoint for testing from local HTML files
router.get("/trigger", async (req, res, next) => {
  try {
    const { to, flowId = "meesho-pickup", customer_name, store_name, pickup_timings } = req.query;
    if (!to) return res.status(400).json({ error: "to required" });

    const flow = flows?.get(flowId);
    if (!flow) return res.status(404).json({ error: \`Flow "\${flowId}" not found\` });

    const { accountSid, apiKey, apiToken, subdomain } = getExotelConfig();
    const backendUrl = process.env.BACKEND_URL || \`https://\${req.headers.host}\`;
    const exophone   = process.env.EXOTEL_PHONE_NUMBER;

    if (!exophone) return res.status(400).json({ error: "EXOTEL_PHONE_NUMBER not set" });

    const variables = { customer_name, store_name, pickup_timings, flowId };
    const varsB64   = Buffer.from(JSON.stringify(variables)).toString("base64");

    const form = new FormData();
    form.append("From",           to);
    form.append("CallerId",       exophone);
    form.append("Url",            \`\${backendUrl}/api/exotel/applet?flowId=\${flowId}&vars=\${encodeURIComponent(varsB64)}\`);
    form.append("StatusCallback", \`\${backendUrl}/api/exotel/status\`);
    form.append("StatusCallbackEvents[0]", "terminal");

    const url  = \`https://\${subdomain}/v1/Accounts/\${accountSid}/Calls/connect\`;
    const auth = Buffer.from(\`\${apiKey}:\${apiToken}\`).toString("base64");

    const resp = await fetch(url, {
      method:  "POST",
      body:    form,
      headers: { ...form.getHeaders(), Authorization: \`Basic \${auth}\` },
    });

    const data = await resp.json().catch(() => ({}));

    res.setHeader("Access-Control-Allow-Origin", "*");

    if (!resp.ok) throw new Error(\`Exotel \${resp.status}: \${JSON.stringify(data)}\`);

    res.json({ callSid: data.Call?.Sid, status: "queued", to, flowId });
  } catch (e) { next(e); }
});

// ── GET /api/exotel/applet ────────────────────────────────────────────────────
// Exotel fetches this URL when the call connects.
// Returns ExoML that opens a bidirectional stream to our WebSocket bot.
router.get("/applet", (req, res) => {
  const { flowId = "meesho-pickup", vars = "" } = req.query;
  const backendUrl = process.env.BACKEND_URL || \`https://\${req.headers.host}\`;
  const wsUrl      = \`\${backendUrl.replace(/^https?/, "wss")}/ws/exotel?flowId=\${encodeURIComponent(flowId)}&vars=\${encodeURIComponent(vars)}\`;

  // ExoML — tells Exotel to open a bidirectional WebSocket stream to our bot
  const exoml = \`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="\${wsUrl}" bidirectional="true" audioTrack="inbound_track">
      <Parameter name="flowId" value="\${flowId}"/>
      <Parameter name="vars"   value="\${vars}"/>
    </Stream>
  </Connect>
</Response>\`;

  res.type("text/xml").send(exoml);
  console.log(\`[Exotel] Applet served | flow=\${flowId} | ws=\${wsUrl}\`);
});

// ── POST /api/exotel/status ───────────────────────────────────────────────────
// Exotel posts call status updates here
router.post("/status", express.urlencoded({ extended: false }), (req, res) => {
  const { CallSid, Status, Duration } = req.body;
  console.log(\`[Exotel] Status | sid=\${CallSid} | status=\${Status} | duration=\${Duration}s\`);
  if (["completed","failed","busy","no-answer"].includes(Status?.toLowerCase())) {
    sessions.delete(CallSid);
  }
  res.sendStatus(200);
});

// ── GET /api/exotel/session/:callSid ─────────────────────────────────────────
router.get("/session/:callSid", (req, res) => {
  const session = sessions.get(req.params.callSid);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ logs: session.getLogs(), history: session.getHistory() });
});

// ── WebSocket server at /ws/exotel ────────────────────────────────────────────
export function attachExotelWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws/exotel" });

  wss.on("connection", (ws, req) => {
    console.log("[Exotel WS] New stream connection");

    // Parse vars from URL query string
    const urlParams = new URL(req.url, "http://localhost");
    const flowId    = urlParams.searchParams.get("flowId") || "meesho-pickup";
    const varsStr   = urlParams.searchParams.get("vars") || "";

    let variables = {};
    try {
      variables = varsStr ? JSON.parse(Buffer.from(varsStr, "base64").toString()) : {};
    } catch (_) {}

    const resolvedFlowId = variables.flowId || flowId;
    const flow = flows?.get(resolvedFlowId);

    if (!flow) {
      console.error(\`[Exotel WS] Unknown flow: \${resolvedFlowId}\`);
      ws.close();
      return;
    }

    console.log(\`[Exotel WS] Session | flow=\${resolvedFlowId} | vars=\${JSON.stringify(variables)}\`);

    const session = new ExotelSession(ws, flow, variables, {
      speaker:  flow.speaker || "priya",
      langCode: flow.lang    || "hi-IN",
    });

    // Store session — callSid comes in the "start" event
    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.event === "start" && msg.start?.call_sid) {
          sessions.set(msg.start.call_sid, session);
        }
      } catch (_) {}
    });

    ws.on("close",  () => console.log("[Exotel WS] Connection closed"));
    ws.on("error",  e  => console.error("[Exotel WS] Error:", e.message));
  });

  console.log("[Exotel WS] Media stream server ready at /ws/exotel");
  return wss;
}

export default router;
`,
  "backend/src/voicebot/exotelSession.js": `import { generateSpeech }  from "../services/sarvam.js";
import { transcribeAudio } from "./stt.js";
import { VAD }             from "./vad.js";
import { FlowEngine }      from "./flowEngine.js";

/**
 * ExotelSession
 *
 * Handles one live Exotel AgentStream WebSocket connection.
 *
 * Exotel protocol (IN from Exotel):
 *   { event:"connected", protocol:"Call", version:"1.0.0" }
 *   { event:"start",  start:{ call_sid, stream_sid, account_sid, custom_parameters:{} } }
 *   { event:"media",  media:{ chunk:N, timestamp, payload:"<base64 PCM16 8kHz>" } }
 *   { event:"stop",   stop:{ call_sid, stream_sid } }
 *   { event:"mark",   mark:{ name } }
 *
 * OUT to Exotel:
 *   { event:"media",  media:{ payload:"<base64 PCM16>" } }   ← play audio
 *   { event:"mark",   mark:{ name:"bot_done" } }              ← track playback end
 *   { event:"clear" }                                          ← interrupt / stop audio
 *
 * Audio format: base64-encoded LINEAR PCM, 8kHz, 16-bit, mono
 * Chunk size: must be multiple of 320 bytes (100ms of audio at 8kHz 16-bit)
 */
export class ExotelSession {
  constructor(ws, flow, variables, options = {}) {
    this.ws        = ws;
    this.flow      = new FlowEngine(flow, variables);
    this.vad       = new VAD({
      speechThreshold: options.speechThreshold ?? 400,
      silenceFrames:   options.silenceFrames   ?? 15,
      minSpeechFrames: options.minSpeechFrames ?? 3,
    });
    this.streamSid  = null;
    this.callSid    = null;
    this.speaker    = options.speaker    || "priya";
    this.sampleRate = 8000;
    this.langCode   = options.langCode   || "hi-IN";
    this.stopped    = false;
    this._timer     = null;
    this._speaking  = false;
    this._logs      = [];
    this._history   = [];

    this._wireVAD();
    this._wireWS();
  }

  // ── WebSocket events ────────────────────────────────────────────────────────
  _wireWS() {
    this.ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.event) {
          case "connected":
            this.log("info", \`Exotel WS connected | protocol=\${msg.protocol}\`);
            break;

          case "start":
            this.streamSid = msg.start?.stream_sid;
            this.callSid   = msg.start?.call_sid;
            const params   = msg.start?.custom_parameters || {};
            this.log("info", \`Stream started | sid=\${this.streamSid} | call=\${this.callSid}\`);
            await this._startFlow();
            break;

          case "media":
            if (this.stopped) break;
            // Exotel sends base64 PCM16 directly (no mulaw conversion needed)
            const pcm = Buffer.from(msg.media.payload, "base64");
            this.vad.processChunk(pcm);
            break;

          case "mark":
            if (msg.mark?.name === "bot_done") {
              this.log("info", "Bot audio finished → listening");
              this._speaking = false;
              this.vad.mode  = "listening";
              this._startCollectTimer();
            }
            break;

          case "stop":
            this.log("info", "Stream stopped by Exotel");
            this._cleanup();
            break;
        }
      } catch (e) {
        this.log("error", \`WS message error: \${e.message}\`);
      }
    });

    this.ws.on("close", () => this._cleanup());
    this.ws.on("error", e => this.log("error", \`WS error: \${e.message}\`));
  }

  // ── VAD callbacks ──────────────────────────────────────────────────────────
  _wireVAD() {
    this.vad.onInterrupt = () => {
      this.log("info", "🛑 INTERRUPT — customer spoke during bot turn");
      this._send({ event: "clear" });
      this._speaking = false;
      this.vad.mode  = "listening";
      clearTimeout(this._timer);
      this._startCollectTimer();
    };

    this.vad.onSpeechStart = () => {
      this.log("info", "🎤 Speech detected");
      clearTimeout(this._timer);
    };

    this.vad.onSpeechEnd = async (pcmBuffer) => {
      this.log("info", \`🎤 Utterance complete (\${(pcmBuffer.length/1024).toFixed(0)}KB)\`);
      clearTimeout(this._timer);
      this.vad.mode = "idle";
      await this._processUtterance(pcmBuffer);
    };
  }

  // ── Start flow ─────────────────────────────────────────────────────────────
  async _startFlow() {
    const text = this.flow.getCurrentText();
    if (!text) { this._endCall(); return; }
    this.log("info", \`Bot: "\${text}"\`);
    await this._speak(text);
  }

  // ── TTS → stream to Exotel ─────────────────────────────────────────────────
  async _speak(text) {
    if (this.stopped) return;
    this._speaking = true;
    this.vad.mode  = "bot_speaking";

    try {
      const wavBuf = await generateSpeech({
        text,
        speaker:    this.speaker,
        sampleRate: this.sampleRate,
      });

      // Strip WAV header (44 bytes) to get raw PCM
      const pcm = wavBuf.slice(0, 4).toString() === "RIFF" ? wavBuf.slice(44) : wavBuf;

      // Send in 320-byte chunks (100ms at 8kHz 16-bit mono)
      // Exotel requires chunk size to be a multiple of 320
      const CHUNK = 3200; // 1 second chunks for efficiency
      for (let i = 0; i < pcm.length; i += CHUNK) {
        if (this.stopped || !this._speaking) break;
        const chunk = pcm.slice(i, i + CHUNK);
        // Pad last chunk to multiple of 320 if needed
        const padded = chunk.length % 320 === 0
          ? chunk
          : Buffer.concat([chunk, Buffer.alloc(320 - (chunk.length % 320))]);

        this._send({
          event: "media",
          media: { payload: padded.toString("base64") },
        });
      }

      // Send mark event — Exotel echoes it back when audio finishes playing
      this._send({ event: "mark", mark: { name: "bot_done" } });

      // Advance flow
      const next = this.flow.onSpeakComplete();
      await this._handleNext(next);

    } catch (e) {
      this.log("error", \`TTS error: \${e.message}\`);
      this._speaking = false;
    }
  }

  // ── Collect timeout ────────────────────────────────────────────────────────
  _startCollectTimer() {
    clearTimeout(this._timer);
    const ms = this.flow.getTimeout();
    this._timer = setTimeout(async () => {
      const audio = this.vad.flush();
      if (audio && audio.length > 3200) {
        await this._processUtterance(audio);
      } else {
        this.log("info", \`⏰ Silence timeout after \${ms}ms\`);
        const next = this.flow.processInput("");
        await this._handleNext(next);
      }
    }, ms);
  }

  // ── STT → FlowEngine ──────────────────────────────────────────────────────
  async _processUtterance(pcmBuffer) {
    try {
      this.log("info", "Sending to Sarvam STT…");
      const wavBuffer  = pcmToWav(pcmBuffer, this.sampleRate);
      const transcript = await transcribeAudio(wavBuffer, this.langCode);
      this.log("info", \`STT: "\${transcript}"\`);
      this._history.push({ speaker: "user", text: transcript });

      const next = this.flow.processInput(transcript);
      await this._handleNext(next);
    } catch (e) {
      this.log("error", \`STT error: \${e.message}\`);
      const next = this.flow.processInput("");
      await this._handleNext(next);
    }
  }

  // ── Handle next flow step ──────────────────────────────────────────────────
  async _handleNext(result) {
    if (!result || this.stopped) return;
    if (result.action === "end") {
      this.log("info", "Flow complete");
      setTimeout(() => this._endCall(), 2000);
      return;
    }
    if (result.text) {
      this.log("info", \`Bot: "\${result.text}"\`);
      this._history.push({ speaker: "bot", text: result.text });
      await this._speak(result.text);
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────
  _endCall() {
    this.log("info", "Ending call");
    this._cleanup();
    try { this.ws.close(); } catch (_) {}
  }

  _cleanup() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this._timer);
    this.vad.mode = "idle";
  }

  _send(obj) {
    try {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    } catch (_) {}
  }

  log(type, msg) {
    const e = { type, msg, ts: new Date().toISOString() };
    this._logs.push(e);
    console.log(\`[Exotel][\${type.toUpperCase()}] \${msg}\`);
  }

  getLogs()    { return this._logs; }
  getHistory() { return this._history; }
}

// ── Wrap raw PCM16 in WAV header (for Sarvam STT) ──────────────────────────
function pcmToWav(pcm, sampleRate = 8000, channels = 1, bitDepth = 16) {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const hdr        = Buffer.allocUnsafe(44);
  hdr.write("RIFF",     0,  "ascii");
  hdr.writeUInt32LE(36 + pcm.length, 4);
  hdr.write("WAVE",     8,  "ascii");
  hdr.write("fmt ",     12, "ascii");
  hdr.writeUInt32LE(16, 16);
  hdr.writeUInt16LE(1,  20);
  hdr.writeUInt16LE(channels, 22);
  hdr.writeUInt32LE(sampleRate, 24);
  hdr.writeUInt32LE(byteRate,   28);
  hdr.writeUInt16LE(blockAlign, 32);
  hdr.writeUInt16LE(bitDepth,   34);
  hdr.write("data",     36, "ascii");
  hdr.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([hdr, pcm]);
}
`,
  "backend/src/voicebot/flowEngine.js": `/**
 * FlowEngine — executes a voice bot flow definition
 *
 * A flow is a JSON object:
 * {
 *   id: "meesho-pickup",
 *   nodes: [
 *     {
 *       id: "greeting",
 *       type: "speak",                        // speak | collect | branch | end
 *       text: "Hi {customer_name}, your order has arrived at {store_name}.",
 *       next: "ask_confirm"
 *     },
 *     {
 *       id: "ask_confirm",
 *       type: "collect",
 *       text: "Can you confirm you will pick it up today?",
 *       timeout: 5000,                        // ms to wait for response
 *       intents: [
 *         { match: ["yes","haan","confirm","okay","theek","zaroor"], next: "confirmed" },
 *         { match: ["no","nahi","nahi","kal","tomorrow","baad"],     next: "reschedule" },
 *       ],
 *       fallback: "ask_confirm_retry"         // node if no intent matched
 *     },
 *     {
 *       id: "ask_confirm_retry",
 *       type: "collect",
 *       text: "Sorry, I didn't catch that. Please say yes or no.",
 *       timeout: 5000,
 *       intents: [
 *         { match: ["yes","haan","okay"], next: "confirmed" },
 *         { match: ["no","nahi","kal"],   next: "reschedule" },
 *       ],
 *       fallback: "confirmed"                 // assume yes after two misses
 *     },
 *     {
 *       id: "confirmed",
 *       type: "speak",
 *       text: "Great! We will see you at {store_name} between {pickup_timings}. Goodbye!",
 *       next: "end"
 *     },
 *     {
 *       id: "reschedule",
 *       type: "speak",
 *       text: "No problem. Your order will be held for 3 days. Call us if you need help. Goodbye!",
 *       next: "end"
 *     },
 *     { id: "end", type: "end" }
 *   ]
 * }
 */

export class FlowEngine {
  constructor(flow, variables = {}) {
    this.flow      = flow;
    this.variables = variables;           // { customer_name, store_name, ... }
    this.nodeMap   = Object.fromEntries(flow.nodes.map(n => [n.id, n]));
    this.current   = flow.nodes[0].id;    // start at first node
    this.history   = [];
    this.done      = false;
  }

  // ── Current node ──────────────────────────────────────────────────────────
  currentNode() {
    return this.nodeMap[this.current];
  }

  // ── Interpolate {variables} in text ───────────────────────────────────────
  resolve(text) {
    return text.replace(/\\{(\\w+)\\}/g, (_, k) => this.variables[k] || \`{\${k}}\`);
  }

  // ── What text should the bot say right now? ───────────────────────────────
  getCurrentText() {
    const node = this.currentNode();
    if (!node || node.type === "end") return null;
    return this.resolve(node.text);
  }

  // ── How long to wait for user input (ms)? ────────────────────────────────
  getTimeout() {
    return this.currentNode()?.timeout || 5000;
  }

  // ── Process user's transcribed response, return next action ───────────────
  // Returns: { action: "speak"|"collect"|"end", text?, nodeId }
  processInput(transcript) {
    const node = this.currentNode();
    if (!node) return { action: "end" };

    this.history.push({ nodeId: node.id, userSaid: transcript });

    if (node.type !== "collect") {
      // Not a collect node — just advance
      return this._advance(node.next);
    }

    // Intent matching — simple keyword matching (no LLM needed for structured flows)
    const lower = transcript.toLowerCase().trim();
    for (const intent of (node.intents || [])) {
      if (intent.match.some(kw => lower.includes(kw))) {
        return this._advance(intent.next);
      }
    }

    // No intent matched — use fallback
    const fallbackId = node.fallback || "end";
    return this._advance(fallbackId);
  }

  // ── Called when bot finishes speaking a "speak" node ─────────────────────
  onSpeakComplete() {
    const node = this.currentNode();
    if (!node) return { action: "end" };
    if (node.type === "speak") return this._advance(node.next);
    if (node.type === "collect") return { action: "collect", nodeId: node.id, timeout: node.timeout };
    return { action: "end" };
  }

  // ── Internal: move to next node ───────────────────────────────────────────
  _advance(nextId) {
    if (!nextId || nextId === "end" || !this.nodeMap[nextId]) {
      this.done = true;
      return { action: "end" };
    }
    this.current = nextId;
    const next   = this.nodeMap[nextId];

    if (next.type === "end") {
      this.done = true;
      return { action: "end" };
    }

    return {
      action:  next.type === "collect" ? "collect" : "speak",
      nodeId:  next.id,
      text:    this.resolve(next.text),
      timeout: next.timeout,
    };
  }
}
`,
  "backend/src/voicebot/routes.js": `import express       from "express";
import { WebSocketServer } from "ws";
import { VoiceBotSession } from "./session.js";
import { dispatchCall }    from "../services/tanla.js";
import { generateSpeech }  from "../services/sarvam.js";

const router = express.Router();

// ── In-memory flow store (persist to DB in production) ────────────────────
const flows    = new Map();
const sessions = new Map();  // callSid → VoiceBotSession

// ── Default flows ─────────────────────────────────────────────────────────
flows.set("meesho-pickup", {
  id: "meesho-pickup",
  name: "Meesho pickup reminder",
  lang: "hi-IN",
  speaker: "priya",
  nodes: [
    {
      id: "greeting",
      type: "speak",
      text: "Namaste {customer_name}! Aapka Meesho order {store_name} par pahunch gaya hai.",
      next: "ask_confirm",
    },
    {
      id: "ask_confirm",
      type: "collect",
      text: "Kya aap aaj {pickup_timings} ke beech pickup kar sakte hain?",
      timeout: 6000,
      intents: [
        { match: ["yes","haan","ha","theek","zaroor","bilkul","confirm","okay","ok","sure"], next: "confirmed" },
        { match: ["no","nahi","nai","kal","tomorrow","baad","later","nahin"],               next: "reschedule" },
      ],
      fallback: "ask_confirm_retry",
    },
    {
      id: "ask_confirm_retry",
      type: "collect",
      text: "Maafi chahta hoon, mujhe samajh nahi aaya. Kripya haan ya nahi bolein.",
      timeout: 5000,
      intents: [
        { match: ["yes","haan","ha","theek","okay"], next: "confirmed" },
        { match: ["no","nahi","kal"],                next: "reschedule" },
      ],
      fallback: "confirmed",
    },
    {
      id: "confirmed",
      type: "speak",
      text: "Bahut accha! Humein khushi hogi aapko {store_name} mein dekhkar. Dhanyawad!",
      next: "end",
    },
    {
      id: "reschedule",
      type: "speak",
      text: "Koi baat nahi. Aapka order 3 din tak rakha jayega. Zaroorat ho toh hamein call karein. Dhanyawad!",
      next: "end",
    },
    { id: "end", type: "end" },
  ],
});

flows.set("meesho-pickup-en", {
  id: "meesho-pickup-en",
  name: "Meesho pickup reminder (English)",
  lang: "en-IN",
  speaker: "maitreyi",
  nodes: [
    {
      id: "greeting",
      type: "speak",
      text: "Hello {customer_name}! Your Meesho order has arrived at {store_name}.",
      next: "ask_confirm",
    },
    {
      id: "ask_confirm",
      type: "collect",
      text: "Can you confirm you will pick it up today between {pickup_timings}?",
      timeout: 6000,
      intents: [
        { match: ["yes","sure","confirm","okay","will","absolutely","definitely","yep"], next: "confirmed" },
        { match: ["no","cannot","cant","tomorrow","later","busy","nope"],               next: "reschedule" },
      ],
      fallback: "ask_confirm_retry",
    },
    {
      id: "ask_confirm_retry",
      type: "collect",
      text: "I'm sorry, I didn't catch that. Could you please say yes or no?",
      timeout: 5000,
      intents: [
        { match: ["yes","sure","okay","will"], next: "confirmed" },
        { match: ["no","cannot","tomorrow"],   next: "reschedule" },
      ],
      fallback: "confirmed",
    },
    {
      id: "confirmed",
      type: "speak",
      text: "Wonderful! We look forward to seeing you at {store_name}. Have a great day!",
      next: "end",
    },
    {
      id: "reschedule",
      type: "speak",
      text: "No problem at all. Your order will be held for 3 days. Call us anytime you need help. Goodbye!",
      next: "end",
    },
    { id: "end", type: "end" },
  ],
});

// ── REST: list flows ───────────────────────────────────────────────────────
router.get("/", (_, res) => {
  res.json([...flows.values()].map(f => ({
    id:       f.id,
    name:     f.name,
    lang:     f.lang,
    speaker:  f.speaker,
    nodeCount: f.nodes.length,
  })));
});

// ── REST: get flow ─────────────────────────────────────────────────────────
router.get("/:id", (req, res) => {
  const f = flows.get(req.params.id);
  if (!f) return res.status(404).json({ error: "Flow not found" });
  res.json(f);
});

// ── REST: save/update flow ────────────────────────────────────────────────
router.post("/", (req, res) => {
  const flow = req.body;
  if (!flow.id || !flow.nodes?.length) {
    return res.status(400).json({ error: "id and nodes required" });
  }
  flows.set(flow.id, flow);
  console.log(\`[Flow] Saved flow "\${flow.id}" (\${flow.nodes.length} nodes)\`);
  res.json({ ok: true, id: flow.id });
});

// ── REST: delete flow ─────────────────────────────────────────────────────
router.delete("/:id", (req, res) => {
  flows.delete(req.params.id);
  res.json({ ok: true });
});

// ── REST: preview TTS for a node ─────────────────────────────────────────
router.post("/:id/preview/:nodeId", async (req, res, next) => {
  try {
    const flow  = flows.get(req.params.id);
    if (!flow) return res.status(404).json({ error: "Flow not found" });

    const node  = flow.nodes.find(n => n.id === req.params.nodeId);
    if (!node) return res.status(404).json({ error: "Node not found" });

    const vars  = req.body.variables || {};
    const text  = node.text.replace(/\\{(\\w+)\\}/g, (_, k) => vars[k] || \`{\${k}}\`);
    const buf   = await generateSpeech({ text, speaker: flow.speaker || "priya", sampleRate: 8000 });

    res.json({ audioBase64: buf.toString("base64"), text });
  } catch (e) { next(e); }
});

// ── REST: dispatch campaign with a flow ──────────────────────────────────
router.post("/:id/campaign", async (req, res, next) => {
  try {
    const flow  = flows.get(req.params.id);
    if (!flow)  return res.status(404).json({ error: "Flow not found" });

    const { contacts } = req.body;  // [{ phone_number, customer_name, store_name, pickup_timings }]
    if (!contacts?.length) return res.status(400).json({ error: "contacts array required" });

    // For each contact — dispatch via Tanla
    // Tanla will call back to our WebSocket when the customer picks up
    // At that point, we start the bot session
    const results = [];
    for (const contact of contacts) {
      try {
        // Generate a greeting WAV for the initial blast (before WS picks up)
        // This plays while Tanla connects — then WS takes over
        const greetNode = flow.nodes[0];
        const text = greetNode.text.replace(/\\{(\\w+)\\}/g, (_, k) => contact[k] || \`{\${k}}\`);
        const audioBuf  = await generateSpeech({ text, speaker: flow.speaker, sampleRate: 8000 });

        const csvContent = \`phone_number,customer_name,store_name,pickup_timings\\n\${
          [contact.phone_number, contact.customer_name, contact.store_name, contact.pickup_timings].join(",")
        }\`;

        await dispatchCall({
          phone:       contact.phone_number,
          csvContent,
          audioBuffer: audioBuf,
          audioName:   \`\${contact.phone_number}.wav\`,
        });

        results.push({ phone: contact.phone_number, status: "dispatched" });
        await new Promise(r => setTimeout(r, 500));

      } catch (e) {
        results.push({ phone: contact.phone_number, status: "error", error: e.message });
      }
    }

    res.json({ dispatched: results.filter(r => r.status === "dispatched").length, results });
  } catch (e) { next(e); }
});

// ── WebSocket handler (attached to server in server.js) ───────────────────
export function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws/voicebot" });

  wss.on("connection", (ws, req) => {
    // Extract params from URL: /ws/voicebot?flowId=meesho-pickup&phone=...&vars=...
    const url       = new URL(req.url, "http://localhost");
    const flowId    = url.searchParams.get("flowId") || "meesho-pickup";
    const variables = JSON.parse(url.searchParams.get("vars") || "{}");
    const flow      = flows.get(flowId);

    if (!flow) {
      ws.close(1008, \`Unknown flowId: \${flowId}\`);
      return;
    }

    console.log(\`[WS] New bot session | flow=\${flowId} | vars=\${JSON.stringify(variables)}\`);

    const session = new VoiceBotSession(ws, flow, variables, {
      speaker:    flow.speaker    || "priya",
      sampleRate: flow.sampleRate || 8000,
      langCode:   flow.lang       || "hi-IN",
    });

    const callSid = variables.callSid || \`ws_\${Date.now()}\`;
    sessions.set(callSid, session);
    ws.on("close", () => sessions.delete(callSid));
  });

  console.log("[WS] Voice bot WebSocket server ready at /ws/voicebot");
  return wss;
}

// ── Tanla webhook — call answered ─────────────────────────────────────────
router.post("/webhook/tanla", (req, res) => {
  const { callSid, status, flowId, phone } = req.body;
  console.log(\`[Webhook] Tanla | callSid=\${callSid} | status=\${status}\`);
  // Tanla signals call answered — the media stream opens the WS connection
  // Sessions are created via the WS connection handler above
  res.sendStatus(200);
});

// ── Get session logs ──────────────────────────────────────────────────────
router.get("/session/:callSid/logs", (req, res) => {
  const session = sessions.get(req.params.callSid);
  if (!session) return res.status(404).json({ error: "Session not found" });
  res.json({ logs: session.getLogs(), history: session.getHistory() });
});

export default router;

// Export flow store so other modules (twilioRoutes) can share it
export function getFlows() { return flows; }
`,
  "backend/src/voicebot/session.js": `import { generateSpeech }  from "../services/sarvam.js";
import { transcribeAudio } from "./stt.js";
import { VAD }             from "./vad.js";
import { FlowEngine }      from "./flowEngine.js";

/**
 * VoiceBotSession
 *
 * One instance per active call. Manages the full lifecycle:
 *   - WebSocket connection to the media streaming gateway (Tanla/Karix)
 *   - TTS → stream audio to caller
 *   - VAD → detect speech start/end and interruptions
 *   - STT → transcribe caller's speech
 *   - FlowEngine → advance the conversation
 *
 * The WebSocket message protocol (Tanla media streaming):
 *   IN:  { event: "media",  media: { payload: "<base64 PCM>" } }
 *   IN:  { event: "start",  streamSid: "...", callSid: "..." }
 *   IN:  { event: "stop" }
 *   OUT: { event: "media",  streamSid, media: { payload: "<base64 audio>" } }
 *   OUT: { event: "mark",   streamSid, mark: { name: "done" } }
 *   OUT: { event: "clear",  streamSid }   ← interrupt: stop playing immediately
 */
export class VoiceBotSession {
  constructor(ws, flow, variables, options = {}) {
    this.ws          = ws;
    this.flow        = new FlowEngine(flow, variables);
    this.vad         = new VAD(options.vad || {});
    this.streamSid   = null;
    this.callSid     = null;
    this.speaker     = options.speaker     || "priya";
    this.sampleRate  = options.sampleRate  || 8000;
    this.langCode    = options.langCode    || "hi-IN";
    this.isStopped   = false;
    this._collectTimer = null;
    this._log        = [];

    this._setupVAD();
    this._setupWS();
  }

  // ── WebSocket message handler ─────────────────────────────────────────────
  _setupWS() {
    this.ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw);

        if (msg.event === "start") {
          this.streamSid = msg.streamSid;
          this.callSid   = msg.callSid || msg.start?.callSid;
          this.log("info", \`Call started | callSid=\${this.callSid}\`);
          await this._startFlow();
        }

        if (msg.event === "media") {
          const pcm = Buffer.from(msg.media.payload, "base64");
          this.vad.processChunk(pcm);
        }

        if (msg.event === "stop") {
          this.log("info", "Call stopped by Tanla");
          this._cleanup();
        }

        if (msg.event === "mark" && msg.mark?.name === "bot_done") {
          // Bot finished speaking — switch to listen mode
          this.vad.mode = "listening";
          this.log("info", "Bot finished speaking → listening");
          this._startCollectTimer();
        }

      } catch (e) {
        this.log("error", \`WS message error: \${e.message}\`);
      }
    });

    this.ws.on("close", () => this._cleanup());
    this.ws.on("error", (e) => this.log("error", \`WS error: \${e.message}\`));
  }

  // ── VAD callbacks ─────────────────────────────────────────────────────────
  _setupVAD() {
    this.vad.onInterrupt = () => {
      this.log("info", "🛑 INTERRUPT — customer spoke while bot was talking");
      this._clearAudio();           // stop bot audio immediately
      this.vad.mode = "listening";  // switch to listen
      this._startCollectTimer();
    };

    this.vad.onSpeechStart = () => {
      this.log("info", "🎤 Customer started speaking");
      clearTimeout(this._collectTimer);  // reset timeout while speaking
    };

    this.vad.onSpeechEnd = async (audioBuffer) => {
      this.log("info", \`🎤 Customer finished speaking (\${(audioBuffer.length/1024).toFixed(0)}KB)\`);
      clearTimeout(this._collectTimer);
      this.vad.mode = "idle";
      await this._processUtterance(audioBuffer);
    };
  }

  // ── Start the flow — speak first node ─────────────────────────────────────
  async _startFlow() {
    const text = this.flow.getCurrentText();
    if (!text) { this._endCall(); return; }
    this.log("info", \`Bot speaks: "\${text}"\`);
    await this._speak(text);
  }

  // ── TTS + stream audio to caller ──────────────────────────────────────────
  async _speak(text) {
    if (this.isStopped) return;
    this.vad.mode = "bot_speaking";

    try {
      const audioBuf = await generateSpeech({
        text,
        speaker:    this.speaker,
        sampleRate: this.sampleRate,
      });

      // Send audio in chunks (Tanla expects chunked base64 media events)
      const CHUNK = 4096;
      for (let i = 0; i < audioBuf.length; i += CHUNK) {
        if (this.isStopped || this.vad.mode !== "bot_speaking") break;
        const chunk = audioBuf.slice(i, i + CHUNK);
        this._send({
          event:     "media",
          streamSid: this.streamSid,
          media:     { payload: chunk.toString("base64") },
        });
      }

      // Mark event → triggers "bot_done" callback → switches to listen
      this._send({
        event:     "mark",
        streamSid: this.streamSid,
        mark:      { name: "bot_done" },
      });

      // Advance flow after speaking
      const next = this.flow.onSpeakComplete();
      this._handleNext(next);

    } catch (e) {
      this.log("error", \`TTS failed: \${e.message}\`);
    }
  }

  // ── Collect timer — end listen if user stays silent ───────────────────────
  _startCollectTimer() {
    clearTimeout(this._collectTimer);
    const timeout = this.flow.getTimeout();
    this._collectTimer = setTimeout(async () => {
      const audio = this.vad.flush();
      if (audio && audio.length > 4000) {
        await this._processUtterance(audio);
      } else {
        // Silence timeout — advance flow with empty input
        this.log("info", "⏰ Collect timeout — no speech detected");
        const next = this.flow.processInput("");
        await this._handleNext(next);
      }
    }, timeout);
  }

  // ── STT → Flow ────────────────────────────────────────────────────────────
  async _processUtterance(audioBuffer) {
    try {
      this.log("info", "Sending audio to Sarvam STT…");
      const transcript = await transcribeAudio(audioBuffer, this.langCode);
      this.log("info", \`STT result: "\${transcript}"\`);

      const next = this.flow.processInput(transcript);
      await this._handleNext(next);

    } catch (e) {
      this.log("error", \`STT failed: \${e.message}\`);
      // On STT error, advance with empty transcript
      const next = this.flow.processInput("");
      await this._handleNext(next);
    }
  }

  // ── Handle flow engine result ─────────────────────────────────────────────
  async _handleNext(result) {
    if (!result || this.isStopped) return;

    if (result.action === "end") {
      this.log("info", "Flow complete → ending call");
      this._endCall();
      return;
    }

    if (result.action === "speak" || result.action === "collect") {
      this.log("info", \`Bot speaks: "\${result.text}"\`);
      await this._speak(result.text);
    }
  }

  // ── Stop bot audio (interruption) ────────────────────────────────────────
  _clearAudio() {
    this._send({ event: "clear", streamSid: this.streamSid });
  }

  // ── End the call ──────────────────────────────────────────────────────────
  _endCall() {
    this.log("info", "Ending call");
    this._cleanup();
    try { this.ws.close(); } catch (_) {}
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  _cleanup() {
    this.isStopped = true;
    clearTimeout(this._collectTimer);
    this.vad.mode = "idle";
  }

  // ── Send WS message ───────────────────────────────────────────────────────
  _send(obj) {
    try {
      if (this.ws.readyState === 1) {
        this.ws.send(JSON.stringify(obj));
      }
    } catch (_) {}
  }

  // ── Logging ───────────────────────────────────────────────────────────────
  log(type, msg) {
    const entry = { type, msg, ts: new Date().toISOString() };
    this._log.push(entry);
    console.log(\`[VoiceBot][\${type.toUpperCase()}] \${msg}\`);
  }

  getLogs()  { return this._log; }
  getHistory(){ return this.flow.history; }
}
`,
  "backend/src/voicebot/stt.js": `import fetch from "node-fetch";
import FormData from "form-data";

const STT_URL = "https://api.sarvam.ai/speech-to-text";

/**
 * Transcribe audio buffer → text using Sarvam saarika:v2
 *
 * @param {Buffer} audioBuffer   - Raw audio (WAV/PCM, 8kHz or 16kHz)
 * @param {string} languageCode  - "hi-IN" | "en-IN" (default hi-IN for Hindi/Hinglish)
 * @returns {string}             - Transcribed text
 */
export async function transcribeAudio(audioBuffer, languageCode = "hi-IN") {
  const apiKey = process.env.SARVAM_API_KEY;
  if (!apiKey) throw new Error("SARVAM_API_KEY not configured");

  const form = new FormData();
  form.append("file", audioBuffer, {
    filename:    "audio.wav",
    contentType: "audio/wav",
  });
  form.append("model",                 "saarika:v2");
  form.append("language_code",         languageCode);
  form.append("with_timestamps",       "false");
  form.append("with_disfluencies",     "false");  // clean output, no "um/uh"
  form.append("debug_mode",            "false");

  console.log(\`[STT] Transcribing | size=\${(audioBuffer.length/1024).toFixed(1)}KB | lang=\${languageCode}\`);

  const res = await fetch(STT_URL, {
    method:  "POST",
    body:    form,
    headers: form.getHeaders(),
    timeout: 15000,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(\`Sarvam STT \${res.status}: \${err.message || err.detail || JSON.stringify(err)}\`);
  }

  const data = await res.json();
  const transcript = data.transcript || data.text || "";
  console.log(\`[STT] ✓ "\${transcript}"\`);
  return transcript.trim();
}
`,
  "backend/src/voicebot/twilioAudio.js": `/**
 * Twilio audio codec utilities
 *
 * Twilio Media Streams sends audio as 8kHz µ-law (G.711) base64.
 * Sarvam STT needs PCM16 (signed 16-bit LE).
 * Sarvam TTS returns a WAV file — we strip the header and re-encode to µ-law for Twilio.
 */

// ── µ-law decode table ────────────────────────────────────────────────────────
const MULAW_DECODE = new Int16Array(256);
for (let i = 0; i < 256; i++) {
  let u      = (~i) & 0xFF;
  const sign = u & 0x80;
  const exp  = (u >> 4) & 0x07;
  const mant = u & 0x0F;
  let val    = ((mant << 1) + 33) << (exp + 2);
  val       -= 33;
  MULAW_DECODE[i] = sign ? -val : val;
}

// ── µ-law encode table ────────────────────────────────────────────────────────
const MULAW_ENC = new Uint8Array(65536);
const EXP_LUT   = [0,0,1,1,2,2,2,2,3,3,3,3,3,3,3,3,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4,4];
const BIAS = 0x84, CLIP = 32635;
for (let i = 0; i < 65536; i++) {
  let pcm  = i - 32768;
  let sign = 0;
  if (pcm < 0) { sign = 0x80; pcm = -pcm; }
  if (pcm > CLIP) pcm = CLIP;
  pcm      += BIAS;
  const exp = EXP_LUT[Math.min(pcm >> 8, 30)];
  const mant= (pcm >> (exp + 3)) & 0x0F;
  MULAW_ENC[i] = (~(sign | (exp << 4) | mant)) & 0xFF;
}

/**
 * Twilio base64 µ-law payload → PCM16 Buffer  (feed to VAD + STT)
 */
export function mulawToPcm16(base64mulaw) {
  const src = Buffer.from(base64mulaw, "base64");
  const dst = Buffer.allocUnsafe(src.length * 2);
  for (let i = 0; i < src.length; i++) {
    dst.writeInt16LE(MULAW_DECODE[src[i]], i * 2);
  }
  return dst;
}

/**
 * WAV or raw PCM16 Buffer → base64 µ-law  (send back to Twilio)
 */
export function pcm16ToMulawB64(wavOrPcm) {
  const pcm = wavOrPcm.slice(0, 4).toString() === "RIFF"
    ? wavOrPcm.slice(44)   // strip 44-byte WAV header
    : wavOrPcm;
  const out = Buffer.allocUnsafe(pcm.length >> 1);
  for (let i = 0; i < out.length; i++) {
    const s = pcm.readInt16LE(i * 2);
    out[i]  = MULAW_ENC[s + 32768];
  }
  return out.toString("base64");
}

/**
 * Split audio buffer into 20 ms Twilio chunks (160 bytes µ-law at 8 kHz)
 */
export function toChunks(buf, size = 160) {
  const chunks = [];
  for (let i = 0; i < buf.length; i += size) chunks.push(buf.slice(i, i + size));
  return chunks;
}
`,
  "backend/src/voicebot/twilioRoutes.js": `import express            from "express";
import twilio             from "twilio";
import { WebSocketServer } from "ws";
import { TwilioSession }  from "./twilioSession.js";

const router   = express.Router();
const sessions = new Map();   // callSid → TwilioSession

// ── Flow store reference (shared with main voicebot routes) ───────────────────
// Injected via init() below so we share the same Map
let flows = null;
export function initTwilio(flowStore) { flows = flowStore; }

// ── Twilio client ─────────────────────────────────────────────────────────────
function getTwilioClient() {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (!sid || !token) throw new Error("TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set");
  return twilio(sid, token);
}

// ── POST /api/twilio/call ─────────────────────────────────────────────────────
// Trigger an outbound call to a contact.
// Body: { to, flowId, variables: { customer_name, store_name, pickup_timings } }
router.post("/call", async (req, res, next) => {
  try {
    const { to, flowId = "meesho-pickup", variables = {} } = req.body;
    if (!to) return res.status(400).json({ error: "to (phone number) required" });

    const flow = flows?.get(flowId);
    if (!flow) return res.status(404).json({ error: \`Flow "\${flowId}" not found\` });

    const client     = getTwilioClient();
    const backendUrl = process.env.BACKEND_URL || \`https://\${req.headers.host}\`;
    const varsB64    = Buffer.from(JSON.stringify(variables)).toString("base64");

    // TwiML URL — Twilio will GET this when the call connects
    const twimlUrl = \`\${backendUrl}/api/twilio/twiml?flowId=\${flowId}&vars=\${encodeURIComponent(varsB64)}\`;

    const call = await client.calls.create({
      to,
      from:           process.env.TWILIO_PHONE_NUMBER,
      url:            twimlUrl,
      statusCallback: \`\${backendUrl}/api/twilio/status\`,
      statusCallbackMethod: "POST",
    });

    console.log(\`[Twilio] Outbound call | to=\${to} | sid=\${call.sid} | flow=\${flowId}\`);
    res.json({ callSid: call.sid, status: call.status, to, flowId });

  } catch (e) { next(e); }
});

// ── GET /api/twilio/trigger ──────────────────────────────────────────────────
// Browser-friendly GET endpoint — accepts all params as query string
// Allows calling from local HTML files without CORS preflight issues
router.get("/trigger", async (req, res, next) => {
  try {
    const { to, flowId = "meesho-pickup", customer_name, store_name, pickup_timings, ...rest } = req.query;
    if (!to) return res.status(400).json({ error: "to (phone number) required" });

    const flow = flows?.get(flowId);
    if (!flow) return res.status(404).json({ error: \`Flow "\${flowId}" not found\` });

    const client     = getTwilioClient();
    const backendUrl = process.env.BACKEND_URL || \`https://\${req.headers.host}\`;
    const variables  = { customer_name, store_name, pickup_timings, ...rest };
    const varsB64    = Buffer.from(JSON.stringify(variables)).toString("base64");
    const twimlUrl   = \`\${backendUrl}/api/twilio/twiml?flowId=\${flowId}&vars=\${encodeURIComponent(varsB64)}\`;

    const call = await client.calls.create({
      to,
      from:                process.env.TWILIO_PHONE_NUMBER,
      url:                 twimlUrl,
      statusCallback:      \`\${backendUrl}/api/twilio/status\`,
      statusCallbackMethod:"POST",
    });

    console.log(\`[Twilio] GET trigger | to=\${to} | sid=\${call.sid} | flow=\${flowId}\`);

    // Set CORS header explicitly for local file:// origins
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.json({ callSid: call.sid, status: call.status, to, flowId });
  } catch (e) { next(e); }
});

// ── POST /api/twilio/campaign ─────────────────────────────────────────────────
// Dial all contacts in a CSV batch, each gets their personalised bot flow.
// Body: { contacts: [{ phone_number, customer_name, store_name, pickup_timings }], flowId }
router.post("/campaign", async (req, res, next) => {
  try {
    const { contacts, flowId = "meesho-pickup" } = req.body;
    if (!contacts?.length) return res.status(400).json({ error: "contacts required" });

    const flow = flows?.get(flowId);
    if (!flow) return res.status(404).json({ error: \`Flow "\${flowId}" not found\` });

    const results = [];

    for (const contact of contacts) {
      try {
        const resp = await fetch(\`http://localhost:\${process.env.PORT || 3001}/api/twilio/call\`, {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body:    JSON.stringify({
            to:        contact.phone_number,
            flowId,
            variables: {
              customer_name:  contact.customer_name,
              store_name:     contact.store_name,
              pickup_timings: contact.pickup_timings,
              ...contact,
            },
          }),
        });
        const data = await resp.json();
        results.push({ phone: contact.phone_number, ...data });
      } catch (e) {
        results.push({ phone: contact.phone_number, error: e.message });
      }
      // 500ms gap between calls — avoid Twilio rate limits
      await new Promise(r => setTimeout(r, 500));
    }

    res.json({
      total:      contacts.length,
      dispatched: results.filter(r => r.callSid).length,
      results,
    });

  } catch (e) { next(e); }
});

// ── GET /api/twilio/twiml ─────────────────────────────────────────────────────
// Twilio fetches this when the outbound call is answered.
// Returns TwiML that:
//   1. Connects a Media Stream WebSocket to our backend
//   2. Keeps the call open while the WebSocket runs the bot
router.get("/twiml", (req, res) => {
  const { flowId = "meesho-pickup", vars = "" } = req.query;
  const backendUrl = process.env.BACKEND_URL || \`https://\${req.headers.host}\`;
  const wsUrl = backendUrl.replace(/^https?/, "wss") + "/ws/twilio";

  // If no vars passed (e.g. inbound call), use defaults from flow
  const defaultVars = vars || Buffer.from(JSON.stringify({
    customer_name:  "Customer",
    store_name:     "Meesho Store",
    pickup_timings: "10am to 6pm",
  })).toString("base64");

  const twiml = \`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="\${wsUrl}">
      <Parameter name="flowId" value="\${flowId}"/>
      <Parameter name="vars"   value="\${defaultVars}"/>
    </Stream>
  </Connect>
</Response>\`;

  res.type("text/xml").send(twiml);
  console.log(\`[Twilio] TwiML served | flow=\${flowId} | wsUrl=\${wsUrl} | inbound=\${!vars}\`);
});

// ── POST /api/twilio/status ───────────────────────────────────────────────────
// Twilio posts call status updates here (completed, no-answer, busy, failed)
router.post("/status", (req, res) => {
  const { CallSid, CallStatus, CallDuration } = req.body;
  console.log(\`[Twilio] Call status | sid=\${CallSid} | status=\${CallStatus} | duration=\${CallDuration}s\`);

  // Clean up session if call ended
  if (["completed","no-answer","busy","failed","canceled"].includes(CallStatus)) {
    sessions.delete(CallSid);
  }
  res.sendStatus(200);
});

// ── GET /api/twilio/session/:callSid ─────────────────────────────────────────
// Get live logs and conversation history for a call
router.get("/session/:callSid", (req, res) => {
  const session = sessions.get(req.params.callSid);
  if (!session) return res.status(404).json({ error: "Session not found or call ended" });
  res.json({ logs: session.getLogs(), history: session.getHistory() });
});

// ── WebSocket server — Twilio Media Stream ────────────────────────────────────
// Twilio connects here with live audio when the call is answered.
export function attachTwilioWebSocket(server) {
  const wss = new WebSocketServer({ server, path: "/ws/twilio" });

  wss.on("connection", (ws, req) => {
    console.log("[Twilio WS] New media stream connection");

    // Session is initialised when we receive the "start" event
    // (which contains flowId and vars in customParameters)
    let session = null;

    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.event === "start") {
          const params  = msg.start?.customParameters || {};
          const flowId  = params.flowId || "meesho-pickup";
          const variables = params.vars
            ? JSON.parse(Buffer.from(params.vars, "base64").toString())
            : {};
          const flow    = flows?.get(flowId);

          if (!flow) {
            console.error(\`[Twilio WS] Unknown flowId: \${flowId}\`);
            ws.close();
            return;
          }

          console.log(\`[Twilio WS] Session started | flow=\${flowId} | vars=\${JSON.stringify(variables)}\`);

          session = new TwilioSession(ws, flow, variables, {
            speaker:  flow.speaker || "priya",
            langCode: flow.lang    || "hi-IN",
          });

          const callSid = msg.start?.callSid;
          if (callSid) sessions.set(callSid, session);
        }

        // All other events (media, mark, stop) are handled inside TwilioSession
        // after it attaches its own ws.on("message") handler.
        // Note: TwilioSession sets up its own listener in the constructor,
        // so we don't need to forward events — they're received directly.

      } catch (e) {
        console.error("[Twilio WS] Init error:", e.message);
      }
    });

    ws.on("close",  () => console.log("[Twilio WS] Connection closed"));
    ws.on("error",  e  => console.error("[Twilio WS] Error:", e.message));
  });

  console.log("[Twilio WS] Media stream server ready at /ws/twilio");
  return wss;
}

export default router;
`,
  "backend/src/voicebot/twilioSession.js": `import { generateSpeech }             from "../services/sarvam.js";
import { transcribeAudio }            from "./stt.js";
import { VAD }                        from "./vad.js";
import { FlowEngine }                 from "./flowEngine.js";
import { mulawToPcm16, pcm16ToMulawB64, toChunks } from "./twilioAudio.js";

/**
 * TwilioSession
 *
 * Handles one live Twilio Media Stream WebSocket connection.
 *
 * Twilio protocol (what comes IN from Twilio):
 *   { event:"connected" }
 *   { event:"start",  streamSid, start:{ callSid, customParameters:{flowId,vars} } }
 *   { event:"media",  streamSid, media:{ payload:"<base64 mulaw 8kHz>" } }
 *   { event:"mark",   streamSid, mark:{ name } }
 *   { event:"stop" }
 *
 * What we send OUT to Twilio:
 *   { event:"media",  streamSid, media:{ payload:"<base64 mulaw>" } }  ← play audio
 *   { event:"mark",   streamSid, mark:{ name:"bot_done" } }            ← end of utterance
 *   { event:"clear",  streamSid }                                       ← interrupt / stop
 */
export class TwilioSession {
  constructor(ws, flow, variables, options = {}) {
    this.ws         = ws;
    this.flow       = new FlowEngine(flow, variables);
    this.vad        = new VAD({
      speechThreshold: options.speechThreshold ?? 400,
      silenceFrames:   options.silenceFrames   ?? 15,   // ~750ms silence → end of turn
      minSpeechFrames: options.minSpeechFrames ?? 3,
    });
    this.streamSid  = null;
    this.callSid    = null;
    this.speaker    = options.speaker    || "priya";
    this.sampleRate = 8000;              // Twilio always 8kHz
    this.langCode   = options.langCode   || "hi-IN";
    this.stopped    = false;
    this._timer     = null;
    this._speaking  = false;
    this._logs      = [];
    this._history   = [];

    this._wireVAD();
    this._wireWS();
  }

  // ── Wire up WebSocket events ───────────────────────────────────────────────
  _wireWS() {
    this.ws.on("message", async (raw) => {
      try {
        const msg = typeof raw === "string" ? JSON.parse(raw) : JSON.parse(raw.toString());

        switch (msg.event) {
          case "connected":
            this.log("info", "Twilio WS connected");
            break;

          case "start": {
            this.streamSid = msg.streamSid;
            this.callSid   = msg.start?.callSid;
            // Custom parameters passed via TwiML <Parameter> tags
            const p        = msg.start?.customParameters || {};
            this.log("info", \`Stream started | sid=\${this.streamSid} | call=\${this.callSid}\`);
            await this._startFlow();
            break;
          }

          case "media": {
            if (this.stopped) break;
            // Convert Twilio mulaw → PCM16 → feed VAD
            const pcm = mulawToPcm16(msg.media.payload);
            this.vad.processChunk(pcm);
            break;
          }

          case "mark":
            // Twilio echoes our mark back when audio has finished playing
            if (msg.mark?.name === "bot_done") {
              this.log("info", "Bot audio finished → switching to listen");
              this._speaking  = false;
              this.vad.mode   = "listening";
              this._startCollectTimer();
            }
            break;

          case "stop":
            this.log("info", "Twilio stream stopped");
            this._cleanup();
            break;
        }
      } catch (e) {
        this.log("error", \`WS message error: \${e.message}\`);
      }
    });

    this.ws.on("close", () => this._cleanup());
    this.ws.on("error", e => this.log("error", \`WS error: \${e.message}\`));
  }

  // ── Wire up VAD callbacks ─────────────────────────────────────────────────
  _wireVAD() {
    // Customer spoke while bot was talking → interrupt immediately
    this.vad.onInterrupt = () => {
      this.log("info", "🛑 INTERRUPT — customer spoke during bot turn");
      this._clearAudio();
      this._speaking  = false;
      this.vad.mode   = "listening";
      clearTimeout(this._timer);
      this._startCollectTimer();
    };

    // Customer started speaking (listening mode)
    this.vad.onSpeechStart = () => {
      this.log("info", "🎤 Speech detected");
      clearTimeout(this._timer);   // reset silence timeout while speaking
    };

    // Customer finished speaking → send audio to STT
    this.vad.onSpeechEnd = async (pcmBuffer) => {
      this.log("info", \`🎤 Utterance complete (\${(pcmBuffer.length / 1024).toFixed(0)} KB)\`);
      clearTimeout(this._timer);
      this.vad.mode = "idle";
      await this._processUtterance(pcmBuffer);
    };
  }

  // ── Start the flow — speak first node ─────────────────────────────────────
  async _startFlow() {
    const text = this.flow.getCurrentText();
    if (!text) { this._endCall(); return; }
    this.log("info", \`Bot: "\${text}"\`);
    await this._speak(text);
  }

  // ── Generate TTS and stream to Twilio ─────────────────────────────────────
  async _speak(text) {
    if (this.stopped) return;
    this._speaking = true;
    this.vad.mode  = "bot_speaking";

    try {
      // Generate WAV from Sarvam
      const wavBuf = await generateSpeech({
        text,
        speaker:    this.speaker,
        sampleRate: this.sampleRate,    // 8kHz for telephony
      });

      // Convert WAV → µ-law chunks and stream to Twilio
      const mulaw  = pcm16ToMulawB64(wavBuf);
      const mulawBuf = Buffer.from(mulaw, "base64");
      const chunks   = toChunks(mulawBuf, 160);  // 20ms chunks

      for (const chunk of chunks) {
        if (this.stopped || !this._speaking) break;
        this._send({
          event:     "media",
          streamSid: this.streamSid,
          media:     { payload: chunk.toString("base64") },
        });
      }

      // Send mark — Twilio echoes this back when audio finishes playing
      // This is how we know when to switch to "listening" mode
      this._send({
        event:     "mark",
        streamSid: this.streamSid,
        mark:      { name: "bot_done" },
      });

      // Advance flow engine after speaking
      const next = this.flow.onSpeakComplete();
      await this._handleNext(next);

    } catch (e) {
      this.log("error", \`TTS error: \${e.message}\`);
      this._speaking = false;
    }
  }

  // ── Collect timeout — if user stays silent ────────────────────────────────
  _startCollectTimer() {
    clearTimeout(this._timer);
    const ms = this.flow.getTimeout();
    this._timer = setTimeout(async () => {
      const audio = this.vad.flush();
      if (audio && audio.length > 3200) {   // at least 200ms of audio
        await this._processUtterance(audio);
      } else {
        this.log("info", \`⏰ Silence timeout after \${ms}ms\`);
        const next = this.flow.processInput("");
        await this._handleNext(next);
      }
    }, ms);
  }

  // ── STT → FlowEngine ──────────────────────────────────────────────────────
  async _processUtterance(pcmBuffer) {
    try {
      this.log("info", "Sending to Sarvam STT…");
      // Wrap PCM in a minimal WAV header for Sarvam STT
      const wavBuffer = pcmToWav(pcmBuffer, this.sampleRate);
      const transcript = await transcribeAudio(wavBuffer, this.langCode);
      this.log("info", \`STT: "\${transcript}"\`);
      this._history.push({ speaker: "user", text: transcript });

      const next = this.flow.processInput(transcript);
      await this._handleNext(next);

    } catch (e) {
      this.log("error", \`STT error: \${e.message}\`);
      const next = this.flow.processInput("");
      await this._handleNext(next);
    }
  }

  // ── Handle flow engine result ─────────────────────────────────────────────
  async _handleNext(result) {
    if (!result || this.stopped) return;

    if (result.action === "end") {
      this.log("info", "Flow complete");
      // Give a moment for last audio to play before hanging up
      setTimeout(() => this._endCall(), 2000);
      return;
    }

    if (result.text) {
      this.log("info", \`Bot: "\${result.text}"\`);
      this._history.push({ speaker: "bot", text: result.text });
      await this._speak(result.text);
    }
  }

  // ── Stop bot audio mid-sentence (interruption) ────────────────────────────
  _clearAudio() {
    this._send({ event: "clear", streamSid: this.streamSid });
  }

  // ── Hang up ───────────────────────────────────────────────────────────────
  _endCall() {
    this.log("info", "Ending call");
    this._cleanup();
    try { this.ws.close(); } catch (_) {}
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────
  _cleanup() {
    if (this.stopped) return;
    this.stopped = true;
    clearTimeout(this._timer);
    this.vad.mode = "idle";
  }

  // ── Send to Twilio ────────────────────────────────────────────────────────
  _send(obj) {
    try {
      if (this.ws.readyState === 1) this.ws.send(JSON.stringify(obj));
    } catch (_) {}
  }

  // ── Logging ───────────────────────────────────────────────────────────────
  log(type, msg) {
    const e = { type, msg, ts: new Date().toISOString() };
    this._logs.push(e);
    console.log(\`[Twilio][\${type.toUpperCase()}] \${msg}\`);
  }

  getLogs()    { return this._logs; }
  getHistory() { return this._history; }
}

// ── Helper: wrap raw PCM16 in a WAV header ────────────────────────────────────
// Sarvam STT accepts WAV files — this avoids saving to disk
function pcmToWav(pcmBuf, sampleRate = 8000, channels = 1, bitDepth = 16) {
  const byteRate   = sampleRate * channels * (bitDepth / 8);
  const blockAlign = channels * (bitDepth / 8);
  const header     = Buffer.allocUnsafe(44);

  header.write("RIFF",           0,  "ascii");
  header.writeUInt32LE(36 + pcmBuf.length, 4);
  header.write("WAVE",           8,  "ascii");
  header.write("fmt ",           12, "ascii");
  header.writeUInt32LE(16,       16);          // PCM chunk size
  header.writeUInt16LE(1,        20);          // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitDepth, 34);
  header.write("data",           36, "ascii");
  header.writeUInt32LE(pcmBuf.length, 40);

  return Buffer.concat([header, pcmBuf]);
}
`,
  "backend/src/voicebot/vad.js": `/**
 * VoiceActivityDetector
 *
 * Detects when a caller starts/stops speaking from raw PCM audio chunks.
 * Used for two purposes:
 *   1. Interruption detection — customer speaks while bot is talking
 *   2. End-of-utterance detection — know when customer has finished speaking
 *
 * Algorithm: simple energy-based VAD
 *   - Calculate RMS energy of each incoming chunk
 *   - If energy > threshold → speech detected
 *   - Track consecutive silent frames → end of utterance
 *
 * For production, replace with WebRTC VAD or Silero VAD (more accurate).
 * This implementation works well for telephony (8kHz, 16-bit PCM).
 */

export class VAD {
  constructor(options = {}) {
    this.speechThreshold = options.speechThreshold ?? 500;   // RMS energy threshold
    this.silenceFrames   = options.silenceFrames   ?? 20;    // ~1s of silence at 50ms chunks
    this.minSpeechFrames = options.minSpeechFrames ?? 3;     // min frames to confirm speech

    this._speechCount  = 0;
    this._silenceCount = 0;
    this._speaking     = false;
    this._audioBuffer  = [];

    // Callbacks
    this.onSpeechStart = null;  // () => void
    this.onSpeechEnd   = null;  // (audioBuffer: Buffer) => void
    this.onInterrupt   = null;  // () => void  — called when speech detected during bot turn
  }

  // State: "bot_speaking" | "listening" | "idle"
  set mode(m) { this._mode = m; }
  get mode()  { return this._mode || "idle"; }

  // ── Feed raw PCM chunk ─────────────────────────────────────────────────────
  processChunk(pcmBuffer) {
    const energy = this._rms(pcmBuffer);
    const isSpeech = energy > this.speechThreshold;

    if (isSpeech) {
      this._speechCount++;
      this._silenceCount = 0;
      this._audioBuffer.push(pcmBuffer);

      if (!this._speaking && this._speechCount >= this.minSpeechFrames) {
        this._speaking = true;

        if (this._mode === "bot_speaking") {
          // Customer interrupted the bot
          this.onInterrupt?.();
        } else if (this._mode === "listening") {
          this.onSpeechStart?.();
        }
      }
    } else {
      // Silence frame
      if (this._speaking) {
        this._audioBuffer.push(pcmBuffer);
        this._silenceCount++;

        if (this._silenceCount >= this.silenceFrames) {
          // End of utterance
          const completeAudio = Buffer.concat(this._audioBuffer);
          this._reset();
          this.onSpeechEnd?.(completeAudio);
        }
      } else {
        this._speechCount = 0;
      }
    }
  }

  // ── Reset state (call after utterance collected) ───────────────────────────
  _reset() {
    this._speaking     = false;
    this._speechCount  = 0;
    this._silenceCount = 0;
    this._audioBuffer  = [];
  }

  // ── RMS energy of 16-bit PCM buffer ───────────────────────────────────────
  _rms(buffer) {
    if (buffer.length < 2) return 0;
    let sum = 0;
    for (let i = 0; i < buffer.length - 1; i += 2) {
      const sample = buffer.readInt16LE(i);
      sum += sample * sample;
    }
    return Math.sqrt(sum / (buffer.length / 2));
  }

  // ── Force end collection (timeout) ────────────────────────────────────────
  flush() {
    if (this._audioBuffer.length > 0) {
      const audio = Buffer.concat(this._audioBuffer);
      this._reset();
      return audio;
    }
    return null;
  }
}
`,
};

for (const [fpath, content] of Object.entries(FILES)) {
  fs.mkdirSync(path.dirname(fpath), { recursive: true });
  fs.writeFileSync(fpath, content);
  console.log("✓", fpath);
}
console.log("\n✅ All files created.");
