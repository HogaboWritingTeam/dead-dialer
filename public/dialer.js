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
console.log("Incoming call (reject)");
call.reject(); // vi tar inte emot inkommande samtal i denna klient
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

// Starta init direkt
initDevice();

// ------------------------------------------------------------
// 6. Telefonbok (namn + nummer, sökbar, redigerbar, i localStorage)
// ------------------------------------------------------------
const CONTACTS_KEY = "hogabo_dialer_contacts";
const MAX_CONTACTS = 50;
let currentFilter = "";

function loadContacts() {
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

function saveContacts(list) {
localStorage.setItem(CONTACTS_KEY, JSON.stringify(list.slice(0, MAX_CONTACTS)));
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
