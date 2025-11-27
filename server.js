require("dotenv").config();
const express = require("express");
const twilio = require("twilio");

const { AccessToken } = twilio.jwt;
const { VoiceGrant } = AccessToken;

const app = express();
const port = process.env.PORT || 3000;

// Twilio-konfig från miljövariabler
const accountSid = process.env.TWILIO_ACCOUNT_SID;
const apiKey = process.env.TWILIO_API_KEY;
const apiSecret = process.env.TWILIO_API_SECRET;
const twimlAppSid = process.env.TWILIO_TWIML_APP_SID;
const callerId = process.env.CALLER_ID || "";

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Hälsokontroll
app.get("/health", (req, res) => {
  res.send("OK");
});

// Token-endpoint
app.get("/token", (req, res) => {
  try {
    const identity = req.query.identity || "mahmoud";

    const token = new AccessToken(accountSid, apiKey, apiSecret, { identity });
    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: twimlAppSid,
      incomingAllow: false,
    });

    token.addGrant(voiceGrant);
    res.json({ token: token.toJwt(), identity });
  } catch (err) {
    console.error("Error creating token:", err);
    res.status(500).json({ error: "Failed to create token" });
  }
});

// Voice-endpoint – testsvar
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say("Dead Dialer backend fungerar. Detta är ett testsamtal.");
  res.type("text/xml");
  res.send(twiml.toString());
});

// Starta servern
app.listen(port, () => {
  console.log(`Dead Dialer backend lyssnar på port ${port}`);
});

