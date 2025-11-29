import { Device } from "@twilio/voice-sdk";

// ------------------------------------------------------------
// 1. Läs ut nummer från URL (?to=...)
// ------------------------------------------------------------
const urlParams = new URLSearchParams(window.location.search);
const destinationNumber = urlParams.get("to") || "";
const numberEl = document.getElementById("number");
numberEl.textContent = destinationNumber || "—";

// ------------------------------------------------------------
// 2. UI-element
// ------------------------------------------------------------
const callBtn = document.getElementById("callBtn");
const hangupBtn = document.getElementById("hangupBtn");
const statusEl = document.getElementById("status");

function updateStatus(text) {
  statusEl.innerHTML = `<span class="status-label">Status:</span> ${text}`;
}

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
let device;
let activeCall = null;

async function initDevice() {
  try {
    updateStatus("Initializing…");

    const token = await getToken();

    device = new Device(token, {
      logLevel: "debug"
      // ev. fler options här vid behov
    });

    device.on("registered", () => {
      console.log("Device registered");
      updateStatus("Ready");
    });

    device.on("error", (error) => {
      console.error("Twilio Device error", error);
      updateStatus("Error: " + (error.message || error.code || "Unknown"));
      callBtn.disabled = false;
      hangupBtn.disabled = true;
    });

    device.on("incoming", (call) => {
      console.log("Incoming call -> reject");
      // Denna dialer är bara för utgående, så vi avvisar automatiskt
      call.reject();
    });

    device.on("connect", (call) => {
      console.log("Call connected");
      activeCall = call;
      updateStatus("In call");
      callBtn.disabled = true;
      hangupBtn.disabled = false;
    });

    device.on("disconnect", () => {
      console.log("Call disconnected");
      activeCall = null;
      updateStatus("Call ended");
      callBtn.disabled = false;
      hangupBtn.disabled = true;
    });

    // Registrera enheten mot Twilio (nödvändigt i v2)
    await device.register();
  } catch (err) {
    console.error("Init device failed:", err);
    updateStatus("Error: could not initialize device");
  }
}

// Kör direkt vid sidladdning
initDevice();

// ------------------------------------------------------------
// 5. Starta samtal
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

  try {
    updateStatus("Connecting…");

    const call = await device.connect({
      params: { To: destinationNumber }
    });

    // resterande hanteras i event-listeners ("connect"/"error")
    activeCall = call;
  } catch (err) {
    console.error("Error starting call:", err);
    updateStatus("Error: " + (err.message || "Failed to connect"));
    callBtn.disabled = false;
    hangupBtn.disabled = true;
  }
});

// ------------------------------------------------------------
// 6. Lägg på
// ------------------------------------------------------------
hangupBtn.addEventListener("click", () => {
  if (activeCall) {
    activeCall.disconnect();
    // "disconnect"-eventet rensar UI
  }
});

