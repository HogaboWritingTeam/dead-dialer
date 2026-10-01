const { Device } = Twilio;

// ------------------------------------------------------------
// 1. UI-element
// ------------------------------------------------------------
const numberEl = document.getElementById("number");
const countryCodeEl = document.getElementById("defaultCountryCode");
const callBtn = document.getElementById("callBtn");
const hangupBtn = document.getElementById("hangupBtn");
const statusEl = document.getElementById("status");
const keypadEl = document.getElementById("keypad");
const contactListEl = document.getElementById("recentNumbers");
const searchEl = document.getElementById("contactSearch");
const addNameEl = document.getElementById("newContactName");
const addNumberEl = document.getElementById("newContactNumber");
const addBtn = document.getElementById("addContactBtn");
const bannerEl = document.getElementById("callBanner");

function updateStatus(text) {
statusEl.innerHTML = `<span class="status-label">Status:</span> ${text}`;
}

function escapeHtml(str) {
const div = document.createElement("div");
div.textContent = str;
return div.innerHTML;
}

// ------------------------------------------------------------
// 1b. Stor, tydlig banner för samtalsutfall (upptaget/inget svar/fel)
// ------------------------------------------------------------
function showBanner(type, text) {
if (!bannerEl) return;
bannerEl.className = "call-banner visible " + type;
bannerEl.textContent = text;
}

function hideBanner() {
if (!bannerEl) return;
bannerEl.className = "call-banner";
bannerEl.textContent = "";
}

// Fråga servern vad utfallet blev för ett visst samtal (klientens CallSid).
// Servern hinner inte alltid skriva klart innan vi frågar första gången,
// så vi provar ett par gånger med kort mellanrum.
async function checkDialOutcome(callSid, attempt) {
if (!callSid) return;
try {
const res = await fetch(`/dial-status/${encodeURIComponent(callSid)}`);
if (!res.ok) return;
const data = await res.json();
const status = data.status;

if (status === "busy") {
showBanner("busy", "UPPTAGET — mottagaren har upptaget");
return;
}
if (status === "no-answer") {
showBanner("noanswer", "INGET SVAR");
return;
}
if (status === "failed" || status === "canceled") {
showBanner("failed", "SAMTALET GICK INTE FRAM");
return;
}
if (status === "completed") {
// Vanligt avslutat samtal – ingen banner behövs
return;
}

// Ingen status ännu – försök igen en gång till
if ((attempt || 0) < 2) {
setTimeout(() => checkDialOutcome(callSid, (attempt || 0) + 1), 500);
}
} catch (e) {
console.error("Error checking dial outcome:", e);
}
}

// ------------------------------------------------------------
// 2. Normalisering av telefonnummer
// ------------------------------------------------------------
// Städar bort mellanslag/bindestreck/parenteser/punkter, konverterar "00"
// till "+", och lägger på en förvald landskod om numret saknar både
// "+" och "00" i början (t.ex. ett spanskt nummer klistrat utan landskod).
const COUNTRY_CODE_KEY = "hogabo_dialer_default_country_code";

function loadDefaultCountryCode() {
return localStorage.getItem(COUNTRY_CODE_KEY) || "+34";
}

function saveDefaultCountryCode(code) {
localStorage.setItem(COUNTRY_CODE_KEY, code);
}

function normalizePhoneNumber(raw, defaultCode) {
if (!raw) return "";

let cleaned = raw.replace(/[\s\-\.\(\)\/]/g, "");

if (cleaned.startsWith("00")) {
cleaned = "+" + cleaned.slice(2).replace(/\+/g, "");
return cleaned;
}

if (cleaned.startsWith("+")) {
cleaned = "+" + cleaned.slice(1).replace(/\+/g, "");
return cleaned;
}

// Inget "+" eller "00" i början – vi vet inte säkert vilket land det
// gäller, så vi antar den förvalda landskoden (satt av användaren ovan)
// och strippar en eventuell ledande nationell nolla.
const code = (defaultCode || "+34").replace(/[^0-9+]/g, "");
const codeWithPlus = code.startsWith("+") ? code : "+" + code;
cleaned = cleaned.replace(/^0+/, "").replace(/\+/g, "");
return codeWithPlus + cleaned;
}

if (countryCodeEl) {
countryCodeEl.value = loadDefaultCountryCode();
countryCodeEl.addEventListener("change", () => {
const code = countryCodeEl.value.trim() || "+34";
countryCodeEl.value = code;
saveDefaultCountryCode(code);
});
}

// ------------------------------------------------------------
// 3. Läs ut nummer från URL (?to=...) och koppla in fältet
// ------------------------------------------------------------
const urlParams = new URLSearchParams(window.location.search);
let destinationNumber = urlParams.get("to") || "";
if (numberEl) {
numberEl.value = destinationNumber;
}

function setDestinationNumber(number, updateUrl) {
destinationNumber = number;
if (numberEl) numberEl.value = number;
if (updateUrl) {
const newUrl = window.location.pathname + (number ? "?to=" + encodeURIComponent(number) : "");
window.history.pushState({}, "", newUrl);
}
}

if (numberEl) {
numberEl.addEventListener("input", () => {
destinationNumber = numberEl.value;
});

numberEl.addEventListener("blur", () => {
const normalized = normalizePhoneNumber(numberEl.value, loadDefaultCountryCode());
setDestinationNumber(normalized, true);
});
}

// Håll reda på aktuell Device och aktivt samtal
let device = null;
let activeCall = null;

// Inledningsvis: kan inte ringa, kan inte lägga på
callBtn.disabled = true;
hangupBtn.disabled = true;

// ------------------------------------------------------------
// 4. Hämta access-token från backend
// ------------------------------------------------------------
async function getToken() {
const res = await fetch("/token");
if (res.status === 401) {
// Sessionen är inte längre giltig – skicka till inloggningssidan
window.location.href = "/login?next=" + encodeURIComponent(window.location.pathname + window.location.search);
throw new Error("Not authenticated");
}
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
// 5. Initiera Twilio Voice Device (SDK v2)
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
callBtn.disabled = false; // nu får vi ringa
hangupBtn.disabled = true; // men kan inte lägga på ännu
});

device.on("error", (error) => {
console.error("Twilio Device error:", error);
updateStatus("Error: " + (error.message || error.code || "Unknown"));
callBtn.disabled = true;
hangupBtn.disabled = true;
});

device.on("incoming", (call) => {
console.log("Incoming call from", call.parameters && call.parameters.From);
handleIncomingCall(call);
});

// Förnya access-token automatiskt strax innan den går ut, så sidan
// aldrig behöver laddas om manuellt för att kunna ringa.
device.on("tokenWillExpire", async () => {
try {
const newToken = await getToken();
device.updateToken(newToken);
console.log("Twilio access token refreshed");
} catch (err) {
console.error("Failed to refresh Twilio token:", err);
}
});

await device.register();
} catch (err) {
console.error("Init device failed:", err);
updateStatus("Error: could not initialize device");
}
}

// Samtalet ska alltid använda en riktig mikrofon – aldrig den virtuella
// "Dialer_ljud"-källan som Översätt-läget skapar för att låta Google Översätt
// lyssna på datorns ljud. Utan detta skulle motparten höra sig själv i stället
// för Freddi när Översätt-läget är på.
const VIRTUAL_MIC_PATTERN = /dialer_ljud|dialer_mic|monitor of/i;

async function preferPhysicalMicrophone() {
if (!device || !device.audio) return;
try {
const inputs = Array.from(device.audio.availableInputDevices.values());
const physical = inputs.find((d) =>
d.deviceId !== "default" && d.deviceId !== "communications" &&
d.label && !VIRTUAL_MIC_PATTERN.test(d.label));
if (!physical) return; // inga namn ännu (ingen mikrofonrättighet) – låt Twilio välja
await device.audio.setInputDevice(physical.deviceId);
console.log("Microphone for calls:", physical.label);
} catch (err) {
console.error("Could not select microphone:", err);
}
}

// ------------------------------------------------------------
// 5b. Inkommande samtal – ringsignal + Svara/Avvisa
// ------------------------------------------------------------
const incomingBannerEl = document.getElementById("incomingBanner");
const incomingNumberEl = document.getElementById("incomingCallerNumber");
const answerBtn = document.getElementById("answerBtn");
const declineBtn = document.getElementById("declineBtn");

let ringtoneCtx = null;
let ringtoneTimer = null;

// Ringsignal genererad i webbläsaren (ingen ljudfil behövs): en mjuk
// två-tons klockklang (E5 → C5), upprepad var 2,5:e sekund. Högre volym än
// tidigare version så den hörs genom högtalare, men med mjuk attack/utklang
// istället för en hård ton – tydligt utan att vara jobbigt.
function startRingtone() {
stopRingtone();
ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
const notes = [659.25, 523.25]; // E5, C5
const ring = () => {
if (!ringtoneCtx) return;
const now = ringtoneCtx.currentTime;
notes.forEach((freq, i) => {
const offset = i * 0.28;
const osc = ringtoneCtx.createOscillator();
const gain = ringtoneCtx.createGain();
osc.type = "sine";
osc.frequency.value = freq;
gain.gain.setValueAtTime(0, now + offset);
gain.gain.linearRampToValueAtTime(0.55, now + offset + 0.04);
gain.gain.setValueAtTime(0.55, now + offset + 0.32);
gain.gain.exponentialRampToValueAtTime(0.001, now + offset + 0.6);
osc.connect(gain);
gain.connect(ringtoneCtx.destination);
osc.start(now + offset);
osc.stop(now + offset + 0.6);
});
};
ring();
ringtoneTimer = setInterval(ring, 2500);
}

function stopRingtone() {
if (ringtoneTimer) {
clearInterval(ringtoneTimer);
ringtoneTimer = null;
}
if (ringtoneCtx) {
ringtoneCtx.close().catch(() => {});
ringtoneCtx = null;
}
}

function showIncomingBanner(fromNumber) {
if (!incomingBannerEl) return;
if (incomingNumberEl) incomingNumberEl.textContent = fromNumber || "Unknown number";
incomingBannerEl.classList.add("visible");
}

function hideIncomingBanner() {
if (!incomingBannerEl) return;
incomingBannerEl.classList.remove("visible");
}

// Be om lov för skrivbordsnotiser i god tid (inte mitt i ett inkommande
// samtal – då är det ofta för sent). Ofarligt att hoppa över om nekad.
if (window.Notification && Notification.permission === "default") {
Notification.requestPermission().catch(() => {});
}

let titleFlashTimer = null;
const originalTitle = document.title;

function startTitleFlash(fromNumber) {
stopTitleFlash();
let on = false;
titleFlashTimer = setInterval(() => {
document.title = on ? originalTitle : `☎ ${fromNumber}`;
on = !on;
}, 1000);
}

function stopTitleFlash() {
if (titleFlashTimer) {
clearInterval(titleFlashTimer);
titleFlashTimer = null;
}
document.title = originalTitle;
}

let incomingNotification = null;

function notifyIncomingCall(fromNumber) {
// Försök lyfta fram fliken/fönstret – fungerar inte i alla webbläsare
// utan användarinteraktion, men kostar inget att försöka.
try { window.focus(); } catch (e) {}

if (window.Notification && Notification.permission === "granted") {
try {
incomingNotification = new Notification("Incoming call", {
body: fromNumber,
requireInteraction: true,
tag: "hogabo-dialer-incoming"
});
incomingNotification.onclick = () => {
try { window.focus(); } catch (e) {}
incomingNotification.close();
};
} catch (e) {
console.error("Could not show notification:", e);
}
}
}

function closeIncomingNotification() {
if (incomingNotification) {
try { incomingNotification.close(); } catch (e) {}
incomingNotification = null;
}
}

// Gemensam upprensning när ett samtal (inkommande eller utgående) tar slut.
function resetCallUi() {
activeCall = null;
callBtn.disabled = false;
hangupBtn.disabled = true;
if (keypadEl) keypadEl.classList.remove("visible");
}

function handleIncomingCall(call) {
const fromNumber = (call.parameters && call.parameters.From) || "Unknown number";
const contactName = findContactName(fromNumber);
const displayNumber = contactName ? `${contactName} (${fromNumber})` : fromNumber;
showIncomingBanner(displayNumber);
startRingtone();
startTitleFlash(displayNumber);
notifyIncomingCall(displayNumber);
updateStatus("Incoming call: " + displayNumber);

const cleanupRinging = () => {
stopRingtone();
stopTitleFlash();
closeIncomingNotification();
hideIncomingBanner();
};

call.on("accept", (acceptedCall) => {
cleanupRinging();
activeCall = acceptedCall;
updateStatus("In call with " + fromNumber);
callBtn.disabled = true;
hangupBtn.disabled = false;
if (keypadEl) keypadEl.classList.add("visible");
});

call.on("disconnect", () => {
cleanupRinging();
updateStatus("Call ended");
resetCallUi();
});

// Den som ringer lägger på innan vi hinner svara
call.on("cancel", () => {
cleanupRinging();
updateStatus("Missed call: " + fromNumber);
resetCallUi();
});

call.on("reject", () => {
cleanupRinging();
updateStatus("Call declined");
resetCallUi();
});

if (answerBtn) {
answerBtn.onclick = () => call.accept();
}
if (declineBtn) {
declineBtn.onclick = () => {
cleanupRinging();
call.reject();
};
}
}

// Starta init direkt
initDevice().then(() => {
preferPhysicalMicrophone();
if (device && device.audio) device.audio.on("deviceChange", preferPhysicalMicrophone);
});

// ------------------------------------------------------------
// 6. Telefonbok (namn + nummer, sökbar, redigerbar)
// ------------------------------------------------------------
// Sparas permanent i Google Sheets via servern. localStorage används som
// lokal kopia: den läses om servern inte svarar, och skrivs varje gång vi
// lyckas hämta/spara mot servern.
const CONTACTS_KEY = "hogabo_dialer_contacts";
const MAX_CONTACTS = 50;
let currentFilter = "";
let contactsCache = null; // fylls vid start

function loadLocalContacts() {
try {
const raw = localStorage.getItem(CONTACTS_KEY);
if (!raw) return [];
const parsed = JSON.parse(raw);
return parsed.map((entry) =>
typeof entry === "string" ? { name: entry, number: entry } : entry
);
} catch (e) {
return [];
}
}

function saveLocalContacts(list) {
localStorage.setItem(CONTACTS_KEY, JSON.stringify(list.slice(0, MAX_CONTACTS)));
}

function loadContacts() {
if (contactsCache === null) {
contactsCache = loadLocalContacts();
}
return contactsCache;
}

function saveContacts(list) {
const trimmed = list.slice(0, MAX_CONTACTS);
contactsCache = trimmed;
saveLocalContacts(trimmed);

// Skicka vidare till servern (Google Sheets). Går det inte fram behåller
// vi den lokala kopian och säger till i statusraden.
fetch("/contacts", {
method: "PUT",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ contacts: trimmed })
})
.then((res) => {
if (!res.ok && res.status !== 503) {
console.error("Kunde inte spara telefonboken på servern:", res.status);
updateStatus("Phone book: save failed (kept locally)");
}
})
.catch((err) => {
console.error("Nätverksfel vid sparning av telefonboken:", err);
updateStatus("Phone book: offline (kept locally)");
});
}

// Hämtar telefonboken från servern vid start. Lyckas det blir Sheets
// facit; annars behålls den lokala kopian.
async function syncContactsFromServer() {
try {
const res = await fetch("/contacts", { cache: "no-store" });
if (!res.ok) return;
const data = await res.json();
if (!data.configured) return; // Sheets inte inkopplat än – kör lokalt
contactsCache = data.contacts || [];
saveLocalContacts(contactsCache);
renderContacts();
// Röstmeddelanden/samtalslogg kan redan ha ritats upp utan namn (hann
// ladda före telefonboken) – rita om dem nu när namnen finns.
if (typeof loadVoicemails === "function") loadVoicemails();
if (typeof loadCallLog === "function") loadCallLog();
} catch (err) {
console.error("Kunde inte hämta telefonboken från servern:", err);
}
}

// Anropas efter ett lyckat samtal: lägg till numret om det inte redan finns
// (utan att skriva över ett namn som redan satts)
function upsertDialedNumber(number) {
if (!number) return;
let list = loadContacts();
const existing = list.find((c) => c.number === number);
list = list.filter((c) => c.number !== number);
list.unshift(existing || { name: number, number });
saveContacts(list);
renderContacts();
}

// Manuellt tillagd/uppdaterad kontakt via formuläret (utan att ha ringt)
function addOrUpdateContactManual(name, number) {
if (!number) return;
const finalName = name || number;
let list = loadContacts();
list = list.filter((c) => c.number !== number);
list.unshift({ name: finalName, number });
saveContacts(list);
renderContacts();
}

function renameContact(number, newName) {
const list = loadContacts();
const entry = list.find((c) => c.number === number);
if (entry) {
entry.name = newName || number;
saveContacts(list);
}
renderContacts();
}

function deleteContact(number) {
const list = loadContacts().filter((c) => c.number !== number);
saveContacts(list);
renderContacts();
}

function selectNumber(number) {
setDestinationNumber(number, true);
}

function startRename(li, contact) {
li.innerHTML = "";
const input = document.createElement("input");
input.type = "text";
input.className = "contact-edit-input";
input.value = contact.name;

const saveBtn = document.createElement("button");
saveBtn.type = "button";
saveBtn.className = "contact-edit-btn";
saveBtn.textContent = "✓";

function commit() {
renameContact(contact.number, input.value.trim());
}

saveBtn.addEventListener("click", commit);
input.addEventListener("keydown", (e) => {
if (e.key === "Enter") commit();
});

li.appendChild(input);
li.appendChild(saveBtn);
input.focus();
}

function renderContacts() {
if (!contactListEl) return;
const list = loadContacts();
const filtered = currentFilter
? list.filter((c) => c.name.toLowerCase().includes(currentFilter.toLowerCase()))
: list;

contactListEl.innerHTML = "";

if (filtered.length === 0) {
contactListEl.innerHTML = '<li class="recent-empty">No numbers yet</li>';
return;
}

filtered.forEach((contact) => {
const li = document.createElement("li");
li.className = "contact-row";

const mainBtn = document.createElement("button");
mainBtn.type = "button";
mainBtn.className = "recent-number-btn";
mainBtn.innerHTML =
`<span class="contact-name">${escapeHtml(contact.name)}</span>` +
(contact.name !== contact.number
? `<span class="contact-number-sub">${escapeHtml(contact.number)}</span>`
: "");
mainBtn.addEventListener("click", () => selectNumber(contact.number));

const editBtn = document.createElement("button");
editBtn.type = "button";
editBtn.className = "contact-edit-btn";
editBtn.textContent = "✎";
editBtn.addEventListener("click", () => startRename(li, contact));

const deleteBtn = document.createElement("button");
deleteBtn.type = "button";
deleteBtn.className = "contact-delete-btn";
deleteBtn.textContent = "🗑";
deleteBtn.addEventListener("click", () => deleteContact(contact.number));

li.appendChild(mainBtn);
li.appendChild(editBtn);
li.appendChild(deleteBtn);
contactListEl.appendChild(li);
});
}

renderContacts();
syncContactsFromServer();

if (searchEl) {
searchEl.addEventListener("input", () => {
currentFilter = searchEl.value;
renderContacts();
});
}

if (addBtn) {
addBtn.addEventListener("click", () => {
const name = addNameEl.value.trim();
const rawNumber = addNumberEl.value.trim();
if (!rawNumber) return;
const number = normalizePhoneNumber(rawNumber, loadDefaultCountryCode());
addOrUpdateContactManual(name, number);
addNameEl.value = "";
addNumberEl.value = "";
});
}

// ------------------------------------------------------------
// 7. Starta utgående samtal
// ------------------------------------------------------------
callBtn.addEventListener("click", async () => {
hideBanner();

// Normalisera alltid direkt innan vi ringer, oavsett hur numret kom in
const normalized = normalizePhoneNumber(numberEl ? numberEl.value : destinationNumber, loadDefaultCountryCode());
setDestinationNumber(normalized, true);

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
const call = await device.connect({
params: { To: destinationNumber }
});

// Spara aktivt samtal så att hangup och knappsats kan använda det
activeCall = call;
updateStatus("In call");
hangupBtn.disabled = false; // nu kan vi lägga på
if (keypadEl) keypadEl.classList.add("visible");

upsertDialedNumber(destinationNumber);

// När motparten/linjen lägger på
call.on("disconnect", (endedCall) => {
console.log("Call disconnected (event)");
const callSid = endedCall && endedCall.parameters ? endedCall.parameters.CallSid : null;
activeCall = null;
updateStatus("Call ended");
callBtn.disabled = false;
hangupBtn.disabled = true;
if (keypadEl) keypadEl.classList.remove("visible");
checkDialOutcome(callSid, 0);
});
} catch (err) {
console.error("Error starting call:", err);
updateStatus("Error: " + (err.message || "Failed to connect"));
activeCall = null;
callBtn.disabled = false;
hangupBtn.disabled = true;
if (keypadEl) keypadEl.classList.remove("visible");
}
});

// ------------------------------------------------------------
// 8. Lägg på (från klienten)
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
if (keypadEl) keypadEl.classList.remove("visible");
updateStatus("Call ended (by you)");
});

// ------------------------------------------------------------
// 8b. Röstmeddelanden (lista + uppspelning)
// ------------------------------------------------------------
const voicemailListEl = document.getElementById("voicemailList");
const refreshVoicemailsBtn = document.getElementById("refreshVoicemailsBtn");

function formatVoicemailTime(iso) {
try {
const d = new Date(iso);
return d.toLocaleString();
} catch (e) {
return iso;
}
}

// Slår upp ett sparat namn för ett nummer i telefonboken, om det finns.
function findContactName(number) {
if (!number) return null;
const match = loadContacts().find((c) => c.number === number);
return match ? match.name : null;
}

function nameAndNumberHtml(number) {
const name = findContactName(number);
if (!name || name === number) return escapeHtml(number || "Unknown number");
return `${escapeHtml(name)} <span class="contact-number-sub">(${escapeHtml(number)})</span>`;
}

async function loadVoicemails() {
if (!voicemailListEl) return;
voicemailListEl.innerHTML = '<li class="recent-empty">Loading…</li>';
try {
const res = await fetch("/voicemails", { cache: "no-store" });
if (!res.ok) throw new Error("HTTP " + res.status);
const data = await res.json();
const list = data.voicemails || [];

voicemailListEl.innerHTML = "";
if (list.length === 0) {
voicemailListEl.innerHTML = '<li class="recent-empty">No voicemails yet</li>';
return;
}

list.forEach((vm) => {
const li = document.createElement("li");
li.className = "voicemail-row";

const info = document.createElement("div");
info.className = "voicemail-info";
const when = vm.day && vm.time
? `${vm.day} ${vm.time}`
: formatVoicemailTime(vm.receivedAt);
info.innerHTML =
`<span class="contact-name">${nameAndNumberHtml(vm.from)}</span>` +
`<span class="contact-number-sub">${escapeHtml(when)} · ${escapeHtml(String(vm.duration))}s</span>`;

const audio = document.createElement("audio");
audio.controls = true;
audio.style.width = "100%";
audio.style.height = "2.2rem";
audio.preload = "none";
audio.src = "/voicemail-audio/" + encodeURIComponent(vm.recordingSid);

li.appendChild(info);
li.appendChild(audio);
voicemailListEl.appendChild(li);
});
} catch (e) {
console.error("Error loading voicemails:", e);
voicemailListEl.innerHTML = '<li class="recent-empty">Could not load voicemails</li>';
}
}

loadVoicemails();
if (refreshVoicemailsBtn) {
refreshVoicemailsBtn.addEventListener("click", loadVoicemails);
}

// ------------------------------------------------------------
// 8c. Samtalslogg (nummer, tid, längd, utfall)
// ------------------------------------------------------------
const callLogListEl = document.getElementById("callLogList");
const refreshCallLogBtn = document.getElementById("refreshCallLogBtn");

const CALL_STATUS_LABELS = {
"completed": "Completed",
"busy": "Busy",
"no-answer": "No answer",
"failed": "Failed",
"canceled": "Canceled"
};

async function loadCallLog() {
if (!callLogListEl) return;
callLogListEl.innerHTML = '<li class="recent-empty">Loading…</li>';
try {
const res = await fetch("/call-log", { cache: "no-store" });
if (!res.ok) throw new Error("HTTP " + res.status);
const data = await res.json();
const list = data.callLog || [];

callLogListEl.innerHTML = "";
if (list.length === 0) {
callLogListEl.innerHTML = '<li class="recent-empty">No calls logged yet</li>';
return;
}

list.forEach((entry) => {
const li = document.createElement("li");
li.className = "call-log-row";
const when = entry.day && entry.time ? `${entry.day} ${entry.time}` : "";
const statusLabel = CALL_STATUS_LABELS[entry.status] || entry.status || "";
li.innerHTML =
`<span class="contact-name">${nameAndNumberHtml(entry.number)}</span>` +
`<span class="contact-number-sub">${escapeHtml(when)} · ${escapeHtml(String(entry.duration))}s · ${escapeHtml(statusLabel)}</span>`;
callLogListEl.appendChild(li);
});
} catch (e) {
console.error("Error loading call log:", e);
callLogListEl.innerHTML = '<li class="recent-empty">Could not load call log</li>';
}
}

loadCallLog();
if (refreshCallLogBtn) {
refreshCallLogBtn.addEventListener("click", loadCallLog);
}

// ------------------------------------------------------------
// 9. Knappsats (DTMF) under pågående samtal – klick + tangentbord
// ------------------------------------------------------------
function sendDigit(digit) {
if (!activeCall) return;
try {
activeCall.sendDigits(digit);
console.log("Sent DTMF digit:", digit);
} catch (e) {
console.error("Error sending DTMF digit:", e);
}
if (keypadEl) {
const btn = keypadEl.querySelector(`button[data-digit="${digit}"]`);
if (btn) {
btn.classList.add("pressed");
setTimeout(() => btn.classList.remove("pressed"), 150);
}
}
}

if (keypadEl) {
keypadEl.querySelectorAll("button[data-digit]").forEach((btn) => {
btn.addEventListener("click", () => sendDigit(btn.getAttribute("data-digit")));
});
}

// Tangentbordets siffror/asterisk/fyrkant skickas som tonval under
// pågående samtal – men inte om man just då skriver i ett textfält
// (t.ex. söker i telefonboken eller döper om en kontakt).
window.addEventListener("keydown", (e) => {
if (!activeCall) return;
const tag = document.activeElement ? document.activeElement.tagName : "";
if (tag === "INPUT" || tag === "TEXTAREA") return;

const key = e.key;
if (/^[0-9]$/.test(key) || key === "*" || key === "#") {
sendDigit(key);
}
});

// ------------------------------------------------------------
// 10. Tillfällig vidarekoppling av inkommande samtal
// ------------------------------------------------------------
const forwardStatusEl = document.getElementById("forwardStatus");
const forwardNumberEl = document.getElementById("forwardNumber");
const forwardSaveBtn = document.getElementById("forwardSaveBtn");
const forwardClearBtn = document.getElementById("forwardClearBtn");

function renderForwardStatus(number) {
if (!forwardStatusEl) return;
if (number) {
forwardStatusEl.textContent = "PÅ – vidarekopplar till " + number;
forwardStatusEl.classList.add("on");
} else {
forwardStatusEl.textContent = "Av";
forwardStatusEl.classList.remove("on");
}
}

async function loadForwardStatus() {
try {
const res = await fetch("/forward", { cache: "no-store" });
if (!res.ok) return;
const data = await res.json();
renderForwardStatus(data.number || "");
if (data.number && forwardNumberEl) forwardNumberEl.value = data.number;
} catch (e) {
console.error("Could not load forwarding status:", e);
}
}

async function setForward(number) {
try {
const res = await fetch("/forward", {
method: "POST",
headers: { "Content-Type": "application/json" },
body: JSON.stringify({ number })
});
if (!res.ok) {
const data = await res.json().catch(() => ({}));
updateStatus("Forwarding: " + (data.error === "invalid_number" ? "invalid number" : "save failed"));
return;
}
const data = await res.json();
renderForwardStatus(data.number || "");
} catch (e) {
console.error("Could not save forwarding:", e);
updateStatus("Forwarding: offline");
}
}

if (forwardSaveBtn) {
forwardSaveBtn.addEventListener("click", () => {
const raw = forwardNumberEl ? forwardNumberEl.value.trim() : "";
if (!raw) return;
const normalized = normalizePhoneNumber(raw, loadDefaultCountryCode());
setForward(normalized);
});
}
if (forwardClearBtn) {
forwardClearBtn.addEventListener("click", () => {
if (forwardNumberEl) forwardNumberEl.value = "";
setForward("");
});
}

loadForwardStatus();
