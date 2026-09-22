require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;

const app = express();
const port = process.env.PORT || 3000;

// -----------------------------
// Twilio-konfiguration via .env
// -----------------------------
const accountSid = process.env.TWILIO_ACCOUNT_SID;     // AC...
const apiKey = process.env.TWILIO_API_KEY;             // SK... (US-regionen)
const apiSecret = process.env.TWILIO_API_SECRET;       // API secret
const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;  // AP... (TwiML App)
const callerId = process.env.CALLER_ID || "";          // t.ex. +34865698050

// -----------------------------
// Budget / usage-webhook-konfig
// -----------------------------
const usageWebhookSecret = process.env.USAGE_WEBHOOK_SECRET || "";

// Enkel budget-flagga i minnet.
// När Twilios Usage Trigger träffar sätter vi detta till true.
let budgetLocked = false;

// -----------------------------
// Senaste utfall per utgående samtal (för "Upptaget"-indikatorn)
// -----------------------------
// Nyckel = CallSid för klientens (webbläsarens) samtalsben.
// Fylls i av /dial-status när Twilio talar om hur uppringningen gick.
const lastDialStatus = {};
const DIAL_STATUS_TTL_MS = 5 * 60 * 1000; // 5 minuter

function rememberDialStatus(callSid, status) {
  lastDialStatus[callSid] = { status, at: Date.now() };
  // Enkel städning av gamla poster vid varje skrivning
  for (const key of Object.keys(lastDialStatus)) {
    if (Date.now() - lastDialStatus[key].at > DIAL_STATUS_TTL_MS) {
      delete lastDialStatus[key];
    }
  }
}

// -----------------------------
// Basic Auth-konfig (två användare)
// -----------------------------
const basicUsers = [
  {
    user: process.env.BASIC_AUTH_USER_1 || "",
    pass: process.env.BASIC_AUTH_PASS_1 || ""
  },
  {
    user: process.env.BASIC_AUTH_USER_2 || "",
    pass: process.env.BASIC_AUTH_PASS_2 || ""
  }
].filter(u => u.user && u.pass);

// -----------------------------
// Inloggning: cookie-session (för att lösenordshanterare ska kunna
// spara/fylla i) med Basic Auth-header som bakåtkompatibel fallback.
// -----------------------------
const SESSION_COOKIE = "dialer_session";

function parseCookies(req) {
  const header = req.headers.cookie || "";
  const out = {};
  header.split(";").forEach((part) => {
    const idx = part.indexOf("=");
    if (idx > -1) {
      const k = part.slice(0, idx).trim();
      const v = part.slice(idx + 1).trim();
      if (k) out[k] = decodeURIComponent(v);
    }
  });
  return out;
}

function decodeUserPass(encoded) {
  try {
    const decoded = Buffer.from(encoded, "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx === -1) return null;
    return { user: decoded.slice(0, idx), pass: decoded.slice(idx + 1) };
  } catch (e) {
    return null;
  }
}

function getCredentialsFromRequest(req) {
  // 1. Cookie-session satt av /login (funkar med lösenordshanterare)
  const cookies = parseCookies(req);
  if (cookies[SESSION_COOKIE]) {
    const creds = decodeUserPass(cookies[SESSION_COOKIE]);
    if (creds) return creds;
  }

  // 2. Klassisk Basic Auth-header (bakåtkompatibelt)
  const authHeader = req.headers.authorization || "";
  const [type, encoded] = authHeader.split(" ");
  if (type === "Basic" && encoded) {
    const creds = decodeUserPass(encoded);
    if (creds) return creds;
  }

  return null;
}

function findAuthenticatedUser(req) {
  // Om inga användare är konfigurerade: släpp igenom (hellre öppet än låst ute dig själv)
  if (basicUsers.length === 0) {
    return { user: "open" };
  }
  const creds = getCredentialsFromRequest(req);
  if (!creds) return null;
  return basicUsers.find((u) => u.user === creds.user && u.pass === creds.pass) || null;
}

// Middleware för sidor (webbläsarnavigering) – skickar vidare till /login
function requireAuthPage(req, res, next) {
  const match = findAuthenticatedUser(req);
  if (match) {
    req.authUser = match.user;
    return next();
  }
  const next_ = encodeURIComponent(req.originalUrl || "/call");
  return res.redirect(`/login?next=${next_}`);
}

// Middleware för API-anrop (fetch) – svarar 401 utan omdirigering
function requireAuthApi(req, res, next) {
  const match = findAuthenticatedUser(req);
  if (match) {
    req.authUser = match.user;
    return next();
  }
  return res.status(401).json({ error: "Not authenticated" });
}

function renderLoginPage(next, showError) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<title>Högabo Music - Login</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Playfair+Display:wght@500;600&family=Roboto:wght@400;500&display=swap">
<style>
html, body { height: 100%; margin: 0; padding: 0; }
body {
font-family: "Roboto", system-ui, -apple-system, BlinkMacSystemFont, sans-serif;
background: radial-gradient(circle at top, #f9f4e8 0%, #f2f2f2 40%, #e7eaef 100%);
display: flex; justify-content: center; align-items: center; color: #333;
}
.login-wrapper {
background: #ffffff; padding: 2.2rem 2.6rem; border-radius: 18px;
box-shadow: 0 16px 40px rgba(0, 0, 0, 0.12); min-width: 300px; max-width: 380px;
text-align: center; border: 1px solid rgba(214, 170, 40, 0.25);
}
.logo { max-width: 220px; margin-bottom: 1.2rem; }
h2 {
font-family: "Playfair Display", serif; font-weight: 600; letter-spacing: 0.08em;
font-size: 1.3rem; margin: 0 0 1.4rem 0; text-transform: uppercase; color: #c59b2a;
}
input[type="text"], input[type="password"] {
width: 100%; box-sizing: border-box; padding: 0.6rem 0.8rem; margin-bottom: 0.8rem;
border: 1px solid #ddd; border-radius: 8px; font-size: 0.95rem;
font-family: "Roboto", system-ui, sans-serif; color: #333;
}
button {
width: 100%; padding: 0.7rem 1.4rem; font-size: 0.95rem; font-weight: 500;
border-radius: 999px; border: none; cursor: pointer; background: #1a9b5b;
color: #ffffff; box-shadow: 0 6px 14px rgba(26, 155, 91, 0.35);
}
button:hover { background: #158149; }
.error { color: #a92f2f; font-size: 0.85rem; margin-bottom: 0.8rem; }
</style>
</head>
<body>
<div class="login-wrapper">
<img src="HogaboMusic-logga2025.gif" alt="Högabo Music" class="logo">
<h2>Log in</h2>
${showError ? '<p class="error">Fel användarnamn eller lösenord.</p>' : ""}
<form method="POST" action="/login">
<input type="hidden" name="next" value="${next}">
<input type="text" name="username" autocomplete="username" placeholder="Username" required>
<input type="password" name="password" autocomplete="current-password" placeholder="Password" required>
<button type="submit">Log in</button>
</form>
</div>
</body>
</html>`;
}

// -----------------------------
// Middleware
// -----------------------------
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static("public"));

// Hälsokontroll
app.get("/health", (req, res) => {
  res.send("OK");
});

// -----------------------------
// Inloggningssida (sparbar av lösenordshanterare)
// -----------------------------
app.get("/login", (req, res) => {
  const next = req.query.next || "/call";
  res.type("html").send(renderLoginPage(next, Boolean(req.query.error)));
});

app.post("/login", (req, res) => {
  const { username, password } = req.body;
  const next = req.body.next || "/call";
  const match = basicUsers.find((u) => u.user === username && u.pass === password);

  if (!match) {
    return res.redirect(`/login?next=${encodeURIComponent(next)}&error=1`);
  }

  const sessionValue = Buffer.from(`${match.user}:${match.pass}`).toString("base64");
  res.cookie(SESSION_COOKIE, sessionValue, {
    httpOnly: true,
    secure: true,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 180 // 180 dagar
  });
  res.redirect(next);
});

// Dialer-sidan (skyddad, omdirigerar till /login om ej inloggad)
app.get("/call", requireAuthPage, (req, res) => {
  res.sendFile(__dirname + "/public/call.html");
});

// -----------------------------
// Token-endpoint för Voice SDK v2 (skyddad)
// -----------------------------
app.get("/token", requireAuthApi, (req, res) => {
  // Om budget-lås är aktivt: dela inte ut fler tokens
  if (budgetLocked) {
    console.warn("Token request blocked: budget lock active");
    return res.status(403).json({
      error: "Budget limit reached – no more calls allowed"
    });
  }

  try {
    // Identitet = inloggad användare om finns, annars ev. query-param, annars "user"
    const identity = req.authUser || req.query.identity || "user";

    const token = new AccessToken(accountSid, apiKey, apiSecret, {
      identity,
      ttl: 14400 // 4 timmar – kompletteras av automatisk förnyelse i dialer.js
    });

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: false
    });

    token.addGrant(voiceGrant);

    res.json({
      token: token.toJwt(),
      identity
    });
  } catch (err) {
    console.error("Error creating token:", err);
    res.status(500).json({ error: "Failed to create token" });
  }
});

// -----------------------------
// Voice-webhook för utgående / inkommande
// -----------------------------
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const from = req.body.From || "";
  const to = req.body.To || "";

  if (from.startsWith("client:") && to) {
    // Utgående samtal från webbdialern till PSTN.
    // action/method gör att Twilio talar om för oss (via /dial-status) om
    // det blev upptaget, inget svar, eller om det gick fram.
    const dial = twiml.dial({
      callerId,
      record: "record-from-answer-dual",
      action: "/dial-status",
      method: "POST"
    });
    dial.number(to);
  } else {
    // Inkommande PSTN-samtal – enkel informationsprompt
    twiml.say(
      { voice: "alice", language: "en-US" },
      "Thank you for calling. This line is currently used for scheduled callbacks. We will contact you as soon as possible."
    );
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// -----------------------------
// Resultat av uppringningsförsöket (busy / no-answer / completed / failed)
// -----------------------------
app.post("/dial-status", (req, res) => {
  // CallSid här = klientens (webbläsarens) samtalsben, samma som
  // activeCall.parameters.CallSid i dialer.js
  const callSid = req.body.CallSid;
  const status = req.body.DialCallStatus;

  if (callSid && status) {
    rememberDialStatus(callSid, status);
  }

  // Inget mer ska hända med klientsamtalet härifrån – Twilio lägger på det.
  const twiml = new twilio.twiml.VoiceResponse();
  res.type("text/xml");
  res.send(twiml.toString());
});

// Webbläsaren frågar efter utfallet strax efter att samtalet kopplats ned
app.get("/dial-status/:callSid", requireAuthApi, (req, res) => {
  const entry = lastDialStatus[req.params.callSid];
  res.json({ status: entry ? entry.status : null });
});

// -----------------------------
// Twilio Usage Trigger webhook
// -----------------------------
app.post("/twilio/usage-alert", (req, res) => {
  const secretFromQuery = req.query.secret || "";

  if (!usageWebhookSecret) {
    console.error("Usage webhook called, but USAGE_WEBHOOK_SECRET is not set");
    return res.status(500).send("Server misconfigured");
  }

  if (secretFromQuery !== usageWebhookSecret) {
    console.warn("Usage webhook: invalid secret in query");
    return res.status(403).send("Forbidden");
  }

  // Twilio skickar data i body (application/x-www-form-urlencoded).
  console.log("Usage webhook payload from Twilio:", req.body);

  // Aktivera budget-lås
  budgetLocked = true;
  console.warn("Budget lock ACTIVATED via usage webhook");

  // Svara Twilio
  res.status(200).send("OK");
});

// -----------------------------
// Starta servern
// -----------------------------
app.listen(port, () => {
  console.log(`Hogabo Dialer backend lyssnar på port ${port}`);
});
