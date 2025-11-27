app.post("/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();

  twiml.say("Dead Dialer backend fungerar. Detta är ett testsamtal.");

  res.type("text/xml");
  res.send(twiml.toString());
});

