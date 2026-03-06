const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const fetch = require("node-fetch");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Validate required env vars on startup
const REQUIRED_ENV = ["OPENAI_API_KEY", "SUPABASE_URL", "SUPABASE_KEY", "TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_FROM", "NOTIFY_NUMBER"];
REQUIRED_ENV.forEach(k => { if (!process.env[k]) console.warn(`WARNING: Missing env var: ${k}`); });

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const SUPABASE_URL   = process.env.SUPABASE_URL;
const SUPABASE_KEY   = process.env.SUPABASE_KEY;
const APP_URL = process.env.APP_URL || "https://nodejs-production-2d3b.up.railway.app";
const path    = require("path");

app.use(cors());
app.use((req, res, next) => {
  if (req.path === "/analyze-watch") return next();
  express.json({ limit: "1mb" })(req, res, next);
});

// Serve the frontend app
app.use(express.static(path.join(__dirname)));
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Multer: 10MB limit, memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

app.post("/analyze-watch", upload.single("photo"), async (req, res) => {
  let originalBuffer = null;
  let resizedBuffer = null;

  try {
    if (!req.file) return res.status(400).json({ error: "No photo uploaded" });

    originalBuffer = req.file.buffer;
    const originalKb = Math.round(originalBuffer.length / 1024);
    console.log("Photo received: " + originalKb + "kb");

    // Resize to 600px max, greyscale (better for engraved text), low quality JPEG
    resizedBuffer = await sharp(originalBuffer)
      .resize({ width: 600, height: 600, fit: "inside", withoutEnlargement: true })
      .greyscale()
      .jpeg({ quality: 60, progressive: false })
      .toBuffer();

    // Free original immediately
    originalBuffer = null;
    req.file.buffer = null;

    const resizedKb = Math.round(resizedBuffer.length / 1024);
    console.log("Compressed to: " + resizedKb + "kb");

    const base64 = resizedBuffer.toString("base64");
    resizedBuffer = null; // free after encoding

    const openaiRes = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + OPENAI_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: 150,
        messages: [{
          role: "user",
          content: [
            {
              type: "text",
              text: "Watch repair expert. Look at this caseback or movement image.\nExtract:\n1. Watch brand (Seiko, Citizen, Omega, Rolex, Tissot, Orient, Casio etc)\n2. Movement number (7N42, NH35, ETA 2824-2, 6P20, Miyota 2035, VK63A, PC21 etc)\n\nReply ONLY with JSON, no markdown:\n{\"brand\":\"name or null\",\"movement\":\"number or null\",\"notes\":\"other text or null\"}"
            },
            {
              type: "image_url",
              image_url: {
                url: "data:image/jpeg;base64," + base64,
                detail: "low"
              }
            }
          ]
        }]
      })
    });

    if (!openaiRes.ok) {
      const errBody = await openaiRes.text();
      console.error("OpenAI error:", openaiRes.status, errBody.slice(0, 300));
      throw new Error("OpenAI error " + openaiRes.status + ": " + errBody.slice(0, 200));
    }

    const openaiData = await openaiRes.json();
    const rawContent = openaiData.choices && openaiData.choices[0] && openaiData.choices[0].message && openaiData.choices[0].message.content;
    if (!rawContent) throw new Error("Empty response from OpenAI");

    console.log("OpenAI raw response:", rawContent);

    const clean = rawContent.replace(/```json\n?|```\n?/g, "").trim();
    let result;
    try {
      result = JSON.parse(clean);
    } catch (e) {
      console.error("JSON parse failed:", clean);
      throw new Error("Could not parse response as JSON");
    }

    console.log("Result:", JSON.stringify(result));
    res.json(result);

  } catch (err) {
    console.error("analyze-watch error:", err.message);
    res.status(500).json({ error: err.message });
  } finally {
    originalBuffer = null;
    resizedBuffer = null;
  }
});

// Send quote SMS
app.post("/send-quote", async (req, res) => {
  try {
    const { repairId, quote, message } = req.body;
    if (!repairId || !quote) return res.status(400).json({ error: "repairId and quote required" });

    const repair = await getRepair(repairId);
    if (!repair.phone) throw new Error("No phone number on file");

    const goUrl = APP_URL + "?action=respond&repair=" + encodeURIComponent(repairId) + "&response=go";
    const noUrl = APP_URL + "?action=respond&repair=" + encodeURIComponent(repairId) + "&response=no";

    const parts = [
      "Hi " + (repair.customer_name || "there") + ", your " + (repair.watch_brand || "watch") + " repair quote from Chrono Repair Studio is $" + quote + ".",
      message || null,
      "Reply YES to go ahead:\n" + goUrl,
      "Reply NO to decline:\n" + noUrl,
    ].filter(Boolean);

    await sendSMS(repair.phone, parts.join("\n\n"));

    const today = new Date().toISOString().slice(0, 10);
    const history = (repair.history || []).concat([{ date: today, event: "Quote of $" + quote + " sent via SMS" }]);
    await patchRepair(repairId, { quote: parseFloat(quote), history, quote_sent_at: today });

    console.log("Quote sent for " + repairId);
    res.json({ success: true });

  } catch (err) {
    console.error("send-quote error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Customer responds to quote
app.post("/customer-respond", async (req, res) => {
  try {
    const { repairId, response } = req.body;
    if (!repairId || !response) return res.status(400).json({ error: "repairId and response required" });

    const repair = await getRepair(repairId);
    const isGoAhead = response === "go";
    const newStatus = isGoAhead ? "Go Ahead" : "Not Going";
    const today = new Date().toISOString().slice(0, 10);
    const event = isGoAhead ? "Customer approved quote via SMS" : "Customer declined quote via SMS";
    const history = (repair.history || []).concat([{ date: today, event }]);

    await patchRepair(repairId, { status: newStatus, history });

    const notifyMsg = isGoAhead
      ? "GO AHEAD - " + (repair.customer_name || "Customer") + " approved $" + repair.quote + " for " + (repair.watch_brand || "watch") + " (" + repairId + ")"
      : "DECLINED - " + (repair.customer_name || "Customer") + " declined $" + repair.quote + " for " + (repair.watch_brand || "watch") + " (" + repairId + ")";

    await sendSMS(process.env.NOTIFY_NUMBER, notifyMsg);

    res.json({ success: true, status: newStatus, repairId });

  } catch (err) {
    console.error("customer-respond error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Supabase helpers
async function getRepair(id) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/repairs?id=eq." + encodeURIComponent(id), {
    headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY }
  });
  if (!res.ok) throw new Error("Supabase fetch failed: " + await res.text());
  const rows = await res.json();
  if (!rows.length) throw new Error("Repair " + id + " not found");
  return rows[0];
}

async function patchRepair(id, data) {
  const res = await fetch(SUPABASE_URL + "/rest/v1/repairs?id=eq." + encodeURIComponent(id), {
    method: "PATCH",
    headers: {
      "apikey": SUPABASE_KEY,
      "Authorization": "Bearer " + SUPABASE_KEY,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(data)
  });
  if (!res.ok) throw new Error("Supabase patch failed: " + await res.text());
}

// Twilio SMS
async function sendSMS(to, body) {
  const SID   = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const FROM  = process.env.TWILIO_FROM;

  let number = to.replace(/[\s\-()]/g, "");
  if (number.startsWith("04"))  number = "+61" + number.slice(1);
  if (number.startsWith("614")) number = "+" + number;
  if (!number.startsWith("+"))  number = "+" + number;

  console.log("Sending SMS to " + number);

  const res = await fetch("https://api.twilio.com/2010-04-01/Accounts/" + SID + "/Messages.json", {
    method: "POST",
    headers: {
      "Authorization": "Basic " + Buffer.from(SID + ":" + TOKEN).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: number, From: FROM, Body: body }).toString(),
  });

  const data = await res.json();
  if (!res.ok) throw new Error("SMS failed (" + res.status + "): " + (data.message || JSON.stringify(data)));
  console.log("SMS sent: " + data.sid);
  return data;
}

app.listen(PORT, () => {
  console.log("Chrono Repair Server on port " + PORT);
  console.log("OpenAI: " + (OPENAI_API_KEY ? "SET" : "MISSING"));
  console.log("Supabase: " + (SUPABASE_URL ? "SET" : "MISSING"));
  console.log("Twilio: " + (process.env.TWILIO_ACCOUNT_SID ? "SET" : "MISSING"));
});
