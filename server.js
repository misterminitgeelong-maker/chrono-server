const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

app.use(cors());
app.use(express.json({ limit: "20mb" }));

// Health check
app.get("/", (req, res) => res.json({ status: "Chrono Repair Server running ✅" }));

// ─── Analyze watch caseback photo ────────────────────────────────────────────
// Accepts multipart/form-data with a "photo" field
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

app.post("/analyze-watch", upload.single("photo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No photo uploaded" });

    // Resize to 800px wide, convert to JPEG — sharp is very memory efficient
    const resized = await sharp(req.file.buffer)
      .resize({ width: 800, withoutEnlargement: true })
      .jpeg({ quality: 75 })
      .toBuffer();

    const base64 = resized.toString("base64");
    const sizeKb = Math.round(base64.length * 0.75 / 1024);
    console.log(`Photo received: ${req.file.originalname}, compressed to ~${sizeKb}kb`);

    // Send to OpenAI Vision
    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 200,
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: `You are a watch repair expert. Analyse this watch caseback or movement image.

Extract if visible:
1. Watch brand (e.g. Seiko, Citizen, Omega, Rolex, Tissot, Orient, Casio)
2. Movement model number (e.g. 7N42, NH35, ETA 2824-2, 6P20, Miyota 2035, VK63A, PC21)

Movement numbers are often engraved on the caseback or visible through a display back.
Common formats: alphanumeric like 7N42, NH35, 2824-2, VK63A, 6P20, PC21, OS10

Respond ONLY with valid JSON, no other text:
{"brand": "brand name or null", "movement": "movement number or null", "notes": "any other useful text"}`
            },
            {
              type: "image_url",
              image_url: { url: `data:image/jpeg;base64,${base64}`, detail: "high" }
            }
          ]
        }]
      })
    });

    if (!openaiRes.ok) {
      const err = await openaiRes.text();
      throw new Error(`OpenAI error: ${err}`);
    }

    const openaiData = await openaiRes.json();
    const content = openaiData.choices?.[0]?.message?.content;
    if (!content) throw new Error("No response from OpenAI");

    const clean = content.replace(/```json|```/g, "").trim();
    const result = JSON.parse(clean);
    console.log("Analysis result:", result);

    res.json(result);

  } catch (err) {
    console.error("analyze-watch error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Send quote SMS ───────────────────────────────────────────────────────────
app.post("/send-quote", async (req, res) => {
  try {
    const { repairId, quote, message } = req.body;

    // Get repair from Supabase
    const repairRes = await fetch(`${SUPABASE_URL}/rest/v1/repairs?id=eq.${encodeURIComponent(repairId)}`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
    });
    const repairs = await repairRes.json();
    const repair = repairs[0];
    if (!repair) throw new Error("Repair not found");
    if (!repair.phone) throw new Error("No phone number on file");

    const APP_URL = process.env.APP_URL || "https://vitejs-vite-duplicat-1yut.bolt.host";
    const goUrl = `${APP_URL}?action=respond&repair=${encodeURIComponent(repairId)}&response=go`;
    const noUrl = `${APP_URL}?action=respond&repair=${encodeURIComponent(repairId)}&response=no`;

    const smsBody =
      `Hi ${repair.customer_name || "there"}, your ${repair.watch_brand || "watch"} repair quote from Chrono Repair Studio is $${quote}.\n\n` +
      (message ? `${message}\n\n` : "") +
      `To GO AHEAD reply YES or visit:\n${goUrl}\n\nTo DECLINE reply NO or visit:\n${noUrl}`;

    await sendSMS(repair.phone, smsBody);

    // Update repair in Supabase
    const today = new Date().toISOString().slice(0, 10);
    const history = [...(repair.history || []), { date: today, event: `Quote of $${quote} sent to customer via SMS` }];
    await fetch(`${SUPABASE_URL}/rest/v1/repairs?id=eq.${encodeURIComponent(repairId)}`, {
      method: "PATCH",
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" },
      body: JSON.stringify({ quote, status: "Awaiting Go Ahead", history, quote_sent_at: today })
    });

    res.json({ success: true });
  } catch (err) {
    console.error("send-quote error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Customer quote response ──────────────────────────────────────────────────
app.post("/customer-respond", async (req, res) => {
  try {
    const { repairId, response } = req.body;

    const repairRes = await fetch(`${SUPABASE_URL}/rest/v1/repairs?id=eq.${encodeURIComponent(repairId)}`, {
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}` }
    });
    const repairs = await repairRes.json();
    const repair = repairs[0];
    if (!repair) throw new Error("Repair not found");

    const isGoAhead = response === "go";
    const newStatus = isGoAhead ? "Go Ahead" : "Not Going";
    const today = new Date().toISOString().slice(0, 10);
    const event = isGoAhead ? "Customer approved quote — GO AHEAD" : "Customer declined quote — NOT GOING";
    const history = [...(repair.history || []), { date: today, event }];

    await fetch(`${SUPABASE_URL}/rest/v1/repairs?id=eq.${encodeURIComponent(repairId)}`, {
      method: "PATCH",
      headers: { "apikey": SUPABASE_KEY, "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "Prefer": "return=representation" },
      body: JSON.stringify({ status: newStatus, history })
    });

    // Notify shop owner
    const notifyMsg = isGoAhead
      ? `✅ GO AHEAD — ${repair.customer_name || "Customer"} approved $${repair.quote} for ${repair.watch_brand || "watch"} (${repairId})`
      : `❌ NO GO — ${repair.customer_name || "Customer"} declined $${repair.quote} for ${repair.watch_brand || "watch"} (${repairId})`;

    await sendSMS(process.env.NOTIFY_NUMBER, notifyMsg);

    res.json({ success: true, status: newStatus, repairId });
  } catch (err) {
    console.error("customer-respond error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── SMS helper via Twilio ────────────────────────────────────────────────────
async function sendSMS(to, body) {
  const ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
  const AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const FROM = process.env.TWILIO_FROM;

  let formatted = to.replace(/\s/g, "");
  if (formatted.startsWith("04")) formatted = "+61" + formatted.slice(1);
  if (!formatted.startsWith("+")) formatted = "+" + formatted;

  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT_SID}/Messages.json`, {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(`${ACCOUNT_SID}:${AUTH_TOKEN}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: formatted, From: FROM, Body: body }).toString(),
  });

  if (!res.ok) {
    const err = await res.json();
    throw new Error("SMS failed: " + (err.message || JSON.stringify(err)));
  }
  return res.json();
}

app.listen(PORT, () => console.log(`Chrono Repair Server running on port ${PORT}`));
