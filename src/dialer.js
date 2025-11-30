import { Device } from "@twilio/voice-sdk";

// ------------------------------------------------------------
// 1. Läs ut nummer från URL (?to=...)
// ------------------------------------------------------------
const urlParams = new URLSearchParams(window.location.search);
const destinationNumber = urlParams.get("to") || "";
const numberEl = document.getElementById("number");
numberEl.textContent = destinationNumber || "–";

// ------------------------------------------------------------
// 2. UI-element
// ------------------------------------------------------------
const callBtn = document.getElementById("callBtn");
const hangupBtn = document.getElementById("hangupBtn");
const statusEl = document.getElementById("status");

function updateStatus(text) {
  statusEl.innerHTML = `<span class="status-label">Status:</span> ${text}`;
}

// Håll reda på aktuell Device och aktivt samtal
let device = null;
let activeCall = null;

// Inledningsvis: kan inte ringa, kan inte lägga på
callBtn.disabled = true;
hangupBtn.disabled = true;

// ------------------------------------------------------------
// 3. Hämta access-token från backend
// ------------------------------------------------------------
async function getToken() {
  const res = await fetch("/token");
  if (!res.ok) {
    throw new Error(`Token HTTP error ${res.status}`);
  }
  const data = await res.json();
  if (!data.token) {
    throw new Error("Token saknas i svar från /token");
  }
  return data.token;
}

// ------------------------------------------------------------
// 4. Initiera Twilio Voice Device (SDK v2)
// ------------------------------------------------------------
async function initDevice() {
  try {
    updateStatus("Initializing…");

    const token = await getToken();

    device = new Device(token, {
      logLevel: "debug"
    });

    device.on("registered", () => {
      console.log("Device registered");
      updateStatus("Ready");
      callBtn.disabled = false;   // nu får vi ringa
      hangupBtn.disabled = true;  // men kan inte lägga på ännu
    });

    device.on("error", (error) => {
      console.error("Twilio Device error:", error);
      updateStatus("Error: " + (error.message || error.code || "Unknown"));
      callBtn.disabled = true;
      hangupBtn.disabled = true;
    });

    device.on("incoming", (call) => {
      console.log("Incoming call (reject)");
      call.reject(); // vi tar inte emot inkommande samtal i denna klient
    });

    await device.register();
  } catch (err) {
    console.error("Init device failed:", err);
    updateStatus("Error: could not initialize device");
  }
}

// Starta init direkt
initDevice();

// ------------------------------------------------------------
// 5. Starta utgående samtal
// ------------------------------------------------------------
callBtn.addEventListener("click", async () => {
  if (!destinationNumber) {
    updateStatus("No number to call");
    return;
  }
  if (!device) {
    updateStatus("Device not ready");
    return;
  }

  updateStatus("Connecting…");
  callBtn.disabled = true;
  hangupBtn.disabled = true; // väntar tills vi har en call-instans

  try {
    const call = await device.connect({ To: destinationNumber });

    // Spara aktivt samtal så att hangup kan använda det
    activeCall = call;
    updateStatus("In call");
    hangupBtn.disabled = false; // nu kan vi lägga på

    // När motparten/linjen lägger på
    call.on("disconnect", () => {
      console.log("Call disconnected (event)");
      activeCall = null;
      updateStatus("Call ended");
      callBtn.disabled = false;
      hangupBtn.disabled = true;
    });
  } catch (err) {
    console.error("Error starting call:", err);
    updateStatus("Error: " + (err.message || "Failed to connect"));
    activeCall = null;
    callBtn.disabled = false;
    hangupBtn.disabled = true;
  }
});

// ------------------------------------------------------------
// 6. Lägg på (från klienten)
// ------------------------------------------------------------
hangupBtn.addEventListener("click", () => {
  console.log("Hangup clicked");

  if (activeCall) {
    // Koppla ned pågående samtal
    try {
      activeCall.disconnect();
    } catch (e) {
      console.error("Error on activeCall.disconnect():", e);
    }
    activeCall = null;
  } else if (device) {
    // Fallback: koppla ned alla eventuella samtal
    try {
      device.disconnectAll();
    } catch (e) {
      console.error("Error on device.disconnectAll():", e);
    }
  }

  // UI tillbaka till "redo att ringa"
  callBtn.disabled = false;
  hangupBtn.disabled = true;
  updateStatus("Call ended (by you)");
});

