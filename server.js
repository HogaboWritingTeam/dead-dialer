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
const callerId = process.env.CALLER_ID;

// Middleware för att läsa inkommande data (Twilio skickar URL-encoded)
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Enkel hälsokontroll
app.get("/health", (req, res) => {
  res.send("OK");
});

// 1) Token-endpoint: ger webbdialern en JWT för Twilio WebRTC
app.get("/token", (req, res) => {
  try {
    const identity = req.query.identity || "mahmoud";

    const token = new AccessToken(accountSid, apiKey, apiSecret, {
      identity,
    });

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

// 2) Voice-endpoint: Twilio frågar här vad som ska göras med samtalet
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  const to = req.body.To || req.query.To;

  if (!to) {
    twiml.say("No destination number specified.");
  } else {
    const dial = twiml.dial({ callerId });
    dial.number(to);
  }

  res.type("text/xml");
  res.send(twiml.toString());
});

// Starta servern
app.listen(port, () => {
  console.log(`Dead Dialer backend lyssnar på port ${port}`);
});

