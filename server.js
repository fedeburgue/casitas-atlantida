/**
 * Backend chico para Casitas Atlántida.
 *
 * - Guarda la configuración del sitio (casitas, fotos, disponibilidad, medios
 *   de pago, temporadas) en un archivo JSON dentro de DATA_DIR.
 * - Permite subir fotos reales.
 * - Sincroniza los calendarios de Airbnb (iCal) y publica un calendario propio
 *   para que Airbnb bloquee las fechas que marcás en el panel.
 * - Todo lo privado (contraseña, enlaces de calendario, token) vive en
 *   DATA_DIR, que NO forma parte del código ni se sube a GitHub.
 */

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 3000;

const SEED_FILE = path.join(__dirname, "data", "config.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// En Render: DATA_DIR=/var/data (disco persistente).
// En tu computadora: una carpeta oculta en tu usuario, fuera del proyecto.
const DATA_DIR = process.env.DATA_DIR || path.join(os.homedir(), ".casitas-atlantida");
const DATA_FILE = path.join(DATA_DIR, "config.json");
const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.copyFileSync(SEED_FILE, DATA_FILE);

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));
// La página de reservas es una vista del mismo sitio: /reservar entrega el mismo archivo.
app.get("/reservar", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
// /admin abre el sitio con el panel del propietario (pide contraseña). No se indexa en buscadores.
app.get("/admin", (req, res) => {
  res.set("X-Robots-Tag", "noindex, nofollow");
  res.sendFile(path.join(PUBLIC_DIR, "index.html"));
});

/* ---------- configuración en disco ---------- */
function readConfig() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}
function writeConfig(cfg) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

const DEFAULT_SEASONS = [
  { label: "Diciembre", from: "12-01", to: "12-21", minNights: 3, usd: 110, uyu: 4620 },
  { label: "Fin de año", from: "12-22", to: "12-31", minNights: 5, usd: 160, uyu: 6720 },
  { label: "Año Nuevo", from: "01-01", to: "01-06", minNights: 5, usd: 195, uyu: 8190 },
  { label: "Enero", from: "01-07", to: "01-15", minNights: 3, usd: 180, uyu: 7560 },
  { label: "Enero", from: "01-16", to: "01-22", minNights: 3, usd: 145, uyu: 6090 },
  { label: "Enero", from: "01-23", to: "01-31", minNights: 3, usd: 120, uyu: 5040 },
  { label: "Febrero", from: "02-01", to: "02-04", minNights: 3, usd: 125, uyu: 5250 },
  { label: "Carnaval", from: "02-05", to: "02-10", minNights: 3, usd: 150, uyu: 6300 },
  { label: "Febrero", from: "02-11", to: "02-21", minNights: 3, usd: 125, uyu: 5250 },
  { label: "Febrero", from: "02-22", to: "02-28", minNights: 2, usd: 100, uyu: 4200 },
  { label: "Marzo", from: "03-01", to: "03-21", minNights: 2, usd: 85, uyu: 3570 },
  { label: "Semana de Turismo", from: "03-22", to: "03-28", minNights: 3, usd: 105, uyu: 4410 },
  { label: "Marzo", from: "03-29", to: "03-31", minNights: 2, usd: 80, uyu: 3360 },
];

// Completa lo que falte en una configuración ya existente (por ejemplo, la
// que quedó guardada en el disco antes de agregar temporadas o sincronización).
function migrate() {
  const cfg = readConfig();
  let changed = false;
  cfg.business = cfg.business || {};
  if (!cfg.seasons) { cfg.seasons = DEFAULT_SEASONS; changed = true; }
  if (!cfg.business.minNights) { cfg.business.minNights = 2; changed = true; }
  if (!cfg.sync) { cfg.sync = {}; changed = true; }
  if (!cfg.sync.icalUrls) { cfg.sync.icalUrls = {}; changed = true; }
  if (!cfg.sync.exportToken) { cfg.sync.exportToken = crypto.randomBytes(16).toString("hex"); changed = true; }
  if (!cfg.availability) { cfg.availability = {}; changed = true; }
  if (changed) writeConfig(cfg);
}
migrate();

// Borra del disco las fotos/audios que ya no están en la configuración
// (con más de 1 hora de antigüedad, para no tocar subidas recién hechas).
function cleanupUploads(cfg) {
  try {
    const text = JSON.stringify(cfg);
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const f of fs.readdirSync(UPLOAD_DIR)) {
      const full = path.join(UPLOAD_DIR, f);
      const st = fs.statSync(full);
      if (st.isFile() && st.mtimeMs < cutoff && !text.includes(f)) fs.unlinkSync(full);
    }
  } catch (e) { console.error("cleanup:", e.message); }
}

/* ---------- autenticación simple ---------- */
function safeEqual(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}
// Máximo 10 contraseñas incorrectas cada 15 minutos por dirección.
const failedLogins = new Map();
const WINDOW_MS = 15 * 60 * 1000, MAX_FAILS = 10;
function isBlocked(ip) {
  const r = failedLogins.get(ip);
  return !!r && Date.now() < r.reset && r.n >= MAX_FAILS;
}
function noteFail(ip) {
  const now = Date.now();
  const r = failedLogins.get(ip);
  if (!r || now >= r.reset) failedLogins.set(ip, { n: 1, reset: now + WINDOW_MS });
  else r.n++;
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, r] of failedLogins) if (now >= r.reset) failedLogins.delete(ip);
}, 10 * 60 * 1000).unref();

function checkAuth(req, res, next) {
  if (isBlocked(req.ip)) return res.status(429).json({ error: "Demasiados intentos. Probá de nuevo en unos minutos." });
  const cfg = readConfig();
  const provided = req.header("x-admin-password");
  if (provided && safeEqual(provided, cfg.business.adminPassword)) return next();
  noteFail(req.ip);
  return res.status(401).json({ error: "No autorizado" });
}

/* ---------- sincronización con Airbnb (iCal) ---------- */
const external = {}; // id de casita -> { dates, lastSync, ok, error }

function ymdToDate(s) {
  return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)));
}

// Devuelve la lista de noches ocupadas (YYYY-MM-DD). La fecha de salida
// (DTEND) no cuenta: ese día queda libre para un nuevo ingreso.
function parseIcs(text) {
  const lines = text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  const dates = new Set();
  let ev = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") ev = {};
    else if (line === "END:VEVENT") {
      if (ev && ev.start) {
        const s = ymdToDate(ev.start);
        const e = ev.end ? ymdToDate(ev.end) : new Date(s.getTime() + 86400000);
        let guard = 0;
        for (let d = new Date(s); d < e && guard < 800; d = new Date(d.getTime() + 86400000), guard++) {
          dates.add(d.toISOString().slice(0, 10));
        }
      }
      ev = null;
    } else if (ev) {
      const m = line.match(/^(DTSTART|DTEND)[^:]*:(\d{8})/);
      if (m) { if (m[1] === "DTSTART") ev.start = m[2]; else ev.end = m[2]; }
    }
  }
  return Array.from(dates).sort();
}

function validIcalUrl(u) {
  try {
    const x = new URL(u);
    return x.protocol === "https:" && /(^|\.)airbnb\.[a-z.]+$/i.test(x.hostname);
  } catch (e) { return false; }
}

async function syncOne(id, url) {
  try {
    if (!validIcalUrl(url)) throw new Error("Enlace no válido");
    const r = await fetch(url, {
      signal: AbortSignal.timeout(15000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; CasitasAtlantida/1.0)" },
    });
    if (!r.ok) throw new Error("Airbnb respondió " + r.status);
    const text = await r.text();
    if (!text.includes("BEGIN:VCALENDAR")) throw new Error("La respuesta no es un calendario");
    external[id] = { dates: parseIcs(text), lastSync: new Date().toISOString(), ok: true };
  } catch (e) {
    const prev = external[id] || {};
    external[id] = { dates: prev.dates || [], lastSync: prev.lastSync || null, ok: false, error: e.message };
  }
}

let syncing = false;
async function syncAll() {
  if (syncing) return;
  syncing = true;
  try {
    const cfg = readConfig();
    const urls = cfg.sync.icalUrls || {};
    for (const c of cfg.casitas) {
      if (urls[c.id]) await syncOne(c.id, urls[c.id]);
      else delete external[c.id];
    }
  } finally { syncing = false; }
}

function statusMap(cfg) {
  const out = {};
  for (const c of cfg.casitas) {
    const e = external[c.id];
    out[c.id] = {
      configured: !!(cfg.sync.icalUrls || {})[c.id],
      ok: e ? e.ok : null,
      lastSync: e ? e.lastSync : null,
      error: e ? e.error || null : null,
      count: e ? e.dates.length : 0,
    };
  }
  return out;
}

/* ---------- rutas públicas ---------- */
app.get("/api/config", (req, res) => {
  const cfg = readConfig();
  const out = JSON.parse(JSON.stringify(cfg));
  delete out.business.adminPassword;
  delete out.sync; // enlaces privados y token: nunca salen al público
  out.externalBusy = {};
  for (const c of cfg.casitas) out.externalBusy[c.id] = (external[c.id] && external[c.id].dates) || [];
  res.set("Cache-Control", "no-store");
  res.json(out);
});

app.post("/api/admin/login", (req, res) => {
  if (isBlocked(req.ip)) return res.status(429).json({ ok: false, error: "Demasiados intentos. Probá de nuevo en unos minutos." });
  const cfg = readConfig();
  const { password } = req.body || {};
  if (password && safeEqual(password, cfg.business.adminPassword)) return res.json({ ok: true });
  noteFail(req.ip);
  res.status(401).json({ ok: false });
});

// Calendario que Airbnb importa para bloquear lo que marcás en el panel.
// Se protege con un token largo en la dirección (Airbnb no puede iniciar sesión).
app.get("/calendar/:id.ics", (req, res) => {
  const cfg = readConfig();
  if (!safeEqual(String(req.query.t || ""), cfg.sync.exportToken)) return res.status(404).send("No encontrado");
  const id = String(parseInt(req.params.id, 10));
  const today = new Date().toISOString().slice(0, 10);
  const dates = ((cfg.availability || {})[id] || []).filter((d) => d >= today).sort();

  const ranges = [];
  for (const d of dates) {
    const last = ranges[ranges.length - 1];
    const prevEnd = last ? new Date(ymdToDate(last.end.replace(/-/g, "")).getTime() + 86400000).toISOString().slice(0, 10) : null;
    if (last && prevEnd === d) last.end = d;
    else ranges.push({ start: d, end: d });
  }
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  let ics = "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Casitas Atlantida//ES\r\nCALSCALE:GREGORIAN\r\n";
  for (const r of ranges) {
    const s = r.start.replace(/-/g, "");
    const e = new Date(ymdToDate(r.end.replace(/-/g, "")).getTime() + 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    ics += `BEGIN:VEVENT\r\nUID:casa${id}-${s}@casitas-atlantida\r\nDTSTAMP:${stamp}\r\nDTSTART;VALUE=DATE:${s}\r\nDTEND;VALUE=DATE:${e}\r\nSUMMARY:No disponible\r\nEND:VEVENT\r\n`;
  }
  ics += "END:VCALENDAR\r\n";
  res.set("Content-Type", "text/calendar; charset=utf-8");
  res.send(ics);
});

/* ---------- rutas protegidas ---------- */
app.put("/api/config", checkAuth, (req, res) => {
  const current = readConfig();
  const incoming = req.body || {};
  if (!incoming.business || !Array.isArray(incoming.casitas)) {
    return res.status(400).json({ error: "Configuración inválida" });
  }
  delete incoming.externalBusy; // dato calculado, no se guarda
  const merged = {
    ...incoming,
    business: { ...current.business, ...incoming.business, adminPassword: current.business.adminPassword },
    sync: current.sync, // lo privado se conserva siempre
  };
  writeConfig(merged);
  cleanupUploads(merged);
  res.json({ ok: true });
});

app.post("/api/admin/change-password", checkAuth, (req, res) => {
  const { newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 4) {
    return res.status(400).json({ error: "La contraseña debe tener al menos 4 caracteres" });
  }
  const cfg = readConfig();
  cfg.business.adminPassword = newPassword;
  writeConfig(cfg);
  res.json({ ok: true });
});

app.get("/api/admin/ical", checkAuth, (req, res) => {
  const cfg = readConfig();
  res.json({ urls: cfg.sync.icalUrls || {}, status: statusMap(cfg), exportToken: cfg.sync.exportToken });
});

app.post("/api/admin/ical", checkAuth, async (req, res) => {
  const urls = (req.body && req.body.urls) || {};
  const cfg = readConfig();
  const clean = {};
  for (const c of cfg.casitas) {
    const u = String(urls[c.id] || "").trim();
    if (u) {
      if (!validIcalUrl(u)) return res.status(400).json({ error: `El enlace de ${c.name} no parece ser un calendario de Airbnb` });
      clean[c.id] = u;
    } else delete external[c.id];
  }
  cfg.sync.icalUrls = clean;
  writeConfig(cfg);
  await syncAll();
  res.json({ ok: true, status: statusMap(readConfig()) });
});

/* ---------- subida de fotos ---------- */
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".jpg";
    cb(null, crypto.randomUUID() + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Solo se permiten imágenes"));
    cb(null, true);
  },
});

app.post("/api/upload", checkAuth, upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió ninguna imagen" });
  res.json({ url: "/uploads/" + req.file.filename });
});

const uploadAudio = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 }, // 20 MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("audio/")) return cb(new Error("Solo se permiten archivos de audio (MP3, M4A, etc.)"));
    cb(null, true);
  },
});

app.post("/api/upload-audio", checkAuth, uploadAudio.single("audio"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió ningún audio" });
  res.json({ url: "/uploads/" + req.file.filename });
});

// Videos: MP4 (H.264) recomendado. Tope de 90 MB para que el servicio de hosting no los rechace.
const uploadVideo = multer({
  storage,
  limits: { fileSize: 90 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("video/")) return cb(new Error("Solo se permiten videos (MP4 recomendado)"));
    cb(null, true);
  },
});

app.post("/api/upload-video", checkAuth, (req, res) => {
  uploadVideo.single("video")(req, res, (err) => {
    if (err) {
      const msg = err.code === "LIMIT_FILE_SIZE" ? "El video pesa más de 90 MB. Comprimilo o acortalo y probá de nuevo." : (err.message || "Error al subir el video");
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: "No se recibió ningún video" });
    res.json({ url: "/uploads/" + req.file.filename });
  });
});

app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || "Error" });
  next();
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Casitas Atlántida — backend escuchando en http://localhost:${PORT}`);
    syncAll();
    setInterval(syncAll, 15 * 60 * 1000);
  });
}

module.exports = { app, parseIcs };
