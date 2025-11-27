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

// 2) Voice-endpoint: hanterar både inkommande och utgående samtal
app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  // Om webbdialern skickar ett "To"-nummer ska vi ringa ut
  const to = req.body.To || req.query.To;

  if (to) {
    // UTGÅENDE: ring vidare till det angivna numret med vårt spanska nummer som callerId
    const dial = twiml.dial({ callerId });
    dial.number(to);
  } else {
    // INKOMMANDE: tills vidare, spela bara upp ett kort engelskt meddelande
    twiml.say(
      { voice: "alice", language: "en-US" },
      "Thank you for calling Hogabo Music. This line is currently used for scheduled callbacks. We will contact you as soon as possible."
    );
  }

  res.type("text/xml");
  res.send(twiml.toString());
});


// Starta servern
app.listen(port, () => {
  console.log(`Dead Dialer backend lyssnar på port ${port}`);
});

