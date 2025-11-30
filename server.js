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

// Middleware för Basic Auth på utvalda endpoints
function basicAuth(req, res, next) {
  // Om inga användare är konfigurerade: släpp igenom (hellre öppet än låst ute dig själv)
  if (basicUsers.length === 0) {
    return next();
  }

  const authHeader = req.headers.authorization || "";
  const [type, encoded] = authHeader.split(" ");

  if (type !== "Basic" || !encoded) {
    res.set("WWW-Authenticate", 'Basic realm="Dead Dialer"');
    return res.status(401).send("Authentication required");
  }

  let decoded = "";
  try {
    decoded = Buffer.from(encoded, "base64").toString("utf8");
  } catch (e) {
    res.set("WWW-Authenticate", 'Basic realm="Dead Dialer"');
    return res.status(401).send("Invalid authentication");
  }

  const [user, pass] = decoded.split(":");
  const match = basicUsers.find(u => u.user === user && u.pass === pass);

  if (match) {
    // Spara vem som är inloggad så vi kan använda det som Twilio-identity
    req.authUser = match.user;
    return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="Dead Dialer"');
  return res.status(401).send("Authentication failed");
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

// Dialer-sidan (skyddad med Basic Auth)
app.get("/call", basicAuth, (req, res) => {
  res.sendFile(__dirname + "/public/call.html");
});

// -----------------------------
// Token-endpoint för Voice SDK v2 (skyddad)
// -----------------------------
app.get("/token", basicAuth, (req, res) => {
  // Om budget-lås är aktivt: dela inte ut fler tokens
  if (budgetLocked) {
    console.warn("Token request blocked: budget lock active");
    return res.status(403).json({
      error: "Budget limit reached – no more calls allowed"
    });
  }

  try {
    // Identitet = inloggad användare om finns, annars ev. query-param, annars "mahmoud"
    const identity = req.authUser || req.query.identity || "mahmoud";

    const token = new AccessToken(accountSid, apiKey, apiSecret, {
      identity,
      ttl: 3600 // 1 timme, justera vid behov
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
    // Utgående samtal från webbdialern till PSTN
    const dial = twiml.dial({
      callerId,
      // Spela in från att motparten svarar, dual channel
      record: "record-from-answer-dual"
    });
    dial.number(to);
  } else {
    // Inkommande PSTN-samtal – enkel informationsprompt
    twiml.say(
      { voice: "alice", language: "en-US" },
      "Thank you for calling Hogabo Music. This line is currently used for scheduled callbacks. We will contact you as soon as possible."
    );
  }

  res.type("text/xml");
  res.send(twiml.toString());
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
  console.log(`Dead Dialer backend lyssnar på port ${port}`);
});

