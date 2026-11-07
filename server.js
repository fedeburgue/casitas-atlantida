/**
 * Backend chico para Casitas Atlántida.
 * - Guarda toda la configuración del sitio (casitas, fotos, disponibilidad,
 *   medios de pago) en data/config.json, en el servidor.
 * - Permite subir fotos reales (no solo pegar links) y las guarda en
 *   public/uploads.
 * - Protege la edición con una contraseña simple (la misma que usás para
 *   entrar al panel del propietario en el sitio).
 *
 * Esto es intencionalmente simple: sin base de datos, sin usuarios múltiples.
 * Para un negocio de 4 casitas administrado por una persona, es más que
 * suficiente. Si el negocio crece y necesitás varios usuarios con permisos
 * distintos, se puede migrar a una base de datos más adelante.
 */

const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const SEED_FILE = path.join(__dirname, "data", "config.json");
const PUBLIC_DIR = path.join(__dirname, "public");

// Si existe la variable DATA_DIR (ej: /var/data en Render con disco persistente),
// la configuración y las fotos se guardan ahí y sobreviven a reinicios y
// actualizaciones. Sin DATA_DIR, todo funciona como antes (modo local).
const DATA_DIR = process.env.DATA_DIR || null;
const DATA_FILE = DATA_DIR ? path.join(DATA_DIR, "config.json") : SEED_FILE;
const UPLOAD_DIR = DATA_DIR ? path.join(DATA_DIR, "uploads") : path.join(PUBLIC_DIR, "uploads");

if (DATA_DIR && !fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// Primera vez con disco nuevo: copiar la configuración inicial
if (!fs.existsSync(DATA_FILE)) fs.copyFileSync(SEED_FILE, DATA_FILE);

app.use(cors());
app.use(express.json({ limit: "2mb" }));
app.use("/uploads", express.static(UPLOAD_DIR));
app.use(express.static(PUBLIC_DIR));

/* ---------- helpers de almacenamiento ---------- */
function readConfig() {
  return JSON.parse(fs.readFileSync(DATA_FILE, "utf-8"));
}
function writeConfig(cfg) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(cfg, null, 2), "utf-8");
}

/* ---------- autenticación simple ----------
   El panel de administración envía la contraseña en el header
   'x-admin-password' en cada pedido que modifica datos. */
function checkAuth(req, res, next) {
  const cfg = readConfig();
  const provided = req.header("x-admin-password");
  if (provided && provided === cfg.business.adminPassword) return next();
  return res.status(401).json({ error: "No autorizado" });
}

/* ---------- rutas públicas ---------- */

// Devuelve la configuración del sitio (sin exponer la contraseña de admin)
app.get("/api/config", (req, res) => {
  const cfg = readConfig();
  const publicCfg = JSON.parse(JSON.stringify(cfg));
  delete publicCfg.business.adminPassword;
  res.json(publicCfg);
});

// Login del panel: solo valida la contraseña, no genera sesión server-side
app.post("/api/admin/login", (req, res) => {
  const cfg = readConfig();
  const { password } = req.body || {};
  if (password && password === cfg.business.adminPassword) {
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

/* ---------- rutas protegidas (requieren contraseña) ---------- */

// Guarda toda la configuración editada desde el panel.
// La contraseña de admin nunca se pisa acá: se conserva la que ya
// estaba guardada, para no perderla por accidente.
app.put("/api/config", checkAuth, (req, res) => {
  const current = readConfig();
  const incoming = req.body || {};
  const merged = {
    ...incoming,
    business: {
      ...current.business,
      ...incoming.business,
      adminPassword: current.business.adminPassword,
    },
  };
  writeConfig(merged);
  res.json({ ok: true });
});

// Cambiar la contraseña del panel (endpoint separado, a propósito)
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

// Subida de fotos reales (no requiere link externo)
const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "") || ".jpg";
    cb(null, crypto.randomUUID() + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB por foto
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) return cb(new Error("Solo se permiten imágenes"));
    cb(null, true);
  },
});

app.post("/api/upload", checkAuth, upload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No se recibió ninguna imagen" });
  res.json({ url: "/uploads/" + req.file.filename });
});

app.use((err, req, res, next) => {
  if (err) return res.status(400).json({ error: err.message || "Error" });
  next();
});

app.listen(PORT, () => {
  console.log(`Casitas Atlántida — backend escuchando en http://localhost:${PORT}`);
});
