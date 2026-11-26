/**
 * Asistente de reservas por WhatsApp (API oficial de Meta).
 * Lleva al cliente paso a paso con botones y listas: fechas -> personas -> casa ->
 * fotos -> mascota -> carga eléctrica -> playa -> precio -> reservar/seña.
 * Usa la disponibilidad real del sitio (/api/disponibilidad).
 *
 * Variables de entorno (se cargan en Render, nunca en el código):
 *   WA_TOKEN         token de acceso de Meta (permanente)
 *   WA_PHONE_ID      Phone Number ID del número que atiende
 *   WA_VERIFY_TOKEN  texto que elegís vos; se pega también en Meta al configurar el webhook
 *   WA_APP_SECRET    (recomendado) clave secreta de la app, para validar que los mensajes vienen de Meta
 *   OWNER_WA         tu número con código de país, solo dígitos (ej. 59899123456), para los avisos
 *   SITE_URL         dirección pública del sitio (ej. https://casitas-atlantida.onrender.com)
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

module.exports = function mountWhatsApp(app, { readConfig, DATA_DIR, PORT, checkAuth, today }) {
  const TOKEN = process.env.WA_TOKEN || "";
  const PHONE_ID = process.env.WA_PHONE_ID || "";
  const VERIFY = process.env.WA_VERIFY_TOKEN || "";
  const APP_SECRET = process.env.WA_APP_SECRET || "";
  const OWNER = String(process.env.OWNER_WA || "").replace(/\D/g, "");
  const SITE = (process.env.SITE_URL || "https://casitas-atlantida.onrender.com").replace(/\/$/, "");
  const GRAPH = "https://graph.facebook.com/v25.0/" + PHONE_ID + "/messages";

  const SESS_FILE = path.join(DATA_DIR, "wa-sessions.json");
  const LEADS_FILE = path.join(DATA_DIR, "wa-leads.json");
  let sessions = {};
  try { sessions = JSON.parse(fs.readFileSync(SESS_FILE, "utf-8")); } catch (e) {}
  let saveT = null;
  const save = () => {
    clearTimeout(saveT);
    saveT = setTimeout(() => { try { fs.writeFileSync(SESS_FILE, JSON.stringify(sessions)); } catch (e) {} }, 1500);
  };
  const addLead = (lead) => {
    let a = [];
    try { a = JSON.parse(fs.readFileSync(LEADS_FILE, "utf-8")); } catch (e) {}
    a.push(Object.assign({ fecha: new Date().toISOString() }, lead));
    try { fs.writeFileSync(LEADS_FILE, JSON.stringify(a.slice(-500), null, 2)); } catch (e) {}
  };

  /* ---------- envío ---------- */
  const cut = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
  async function send(body) {
    if (!TOKEN || !PHONE_ID) { console.error("[wa] faltan WA_TOKEN o WA_PHONE_ID"); return; }
    try {
      const r = await fetch(GRAPH, {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ messaging_product: "whatsapp" }, body)),
      });
      if (!r.ok) console.error("[wa] error al enviar", r.status, (await r.text()).slice(0, 300));
    } catch (e) { console.error("[wa] fallo de red", e.message); }
  }
  const text = (to, body) => send({ to, type: "text", text: { body: cut(body, 3900), preview_url: true } });
  const buttons = (to, body, btns) => send({
    to, type: "interactive",
    interactive: {
      type: "button", body: { text: cut(body, 1000) },
      action: { buttons: btns.slice(0, 3).map(b => ({ type: "reply", reply: { id: b[0], title: cut(b[1], 20) } })) },
    },
  });
  const list = (to, body, btnText, rows) => send({
    to, type: "interactive",
    interactive: {
      type: "list", body: { text: cut(body, 1000) },
      action: {
        button: cut(btnText, 20),
        sections: [{ title: "Opciones", rows: rows.slice(0, 10).map(r => ({ id: r[0], title: cut(r[1], 24), description: r[2] ? cut(r[2], 72) : undefined })) }],
      },
    },
  });

  /* ---------- utilidades ---------- */
  const norm = s => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
  const MESES = { enero: 1, ene: 1, febrero: 2, feb: 2, marzo: 3, mar: 3, abril: 4, abr: 4, mayo: 5, may: 5, junio: 6, jun: 6, julio: 7, jul: 7, agosto: 8, ago: 8, septiembre: 9, setiembre: 9, sept: 9, sep: 9, set: 9, octubre: 10, oct: 10, noviembre: 11, nov: 11, diciembre: 12, dic: 12 };
  const MON = Object.keys(MESES).sort((a, b) => b.length - a.length).join("|");
  const pad = n => String(n).padStart(2, "0");
  const valid = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d; };
  const key = (y, m, d) => y + "-" + pad(m) + "-" + pad(d);
  const MES_CORTO = ["", "ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];
  const fmt = k => { const [, m, d] = k.split("-").map(Number); return d + " " + MES_CORTO[m]; };
  const fmtLargo = k => { const [y, m, d] = k.split("-").map(Number); return d + " " + MES_CORTO[m] + " " + y; };

  function parseDates(raw) {
    const t = norm(raw), hoy = today(), yHoy = Number(hoy.slice(0, 4));
    let d1, m1, y1, d2, m2, y2, m;
    m = t.match(/(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?\s*(?:al|a|hasta(?: el)?|-)\s*(\d{1,2})[\/\-.](\d{1,2})(?:[\/\-.](\d{2,4}))?/);
    if (m) {
      d1 = +m[1]; m1 = +m[2]; y1 = m[3] ? +m[3] : null; d2 = +m[4]; m2 = +m[5]; y2 = m[6] ? +m[6] : null;
      if (y1 && y1 < 100) y1 += 2000; if (y2 && y2 < 100) y2 += 2000;
    } else {
      m = t.match(new RegExp("(\\d{1,2})(?:\\s*de)?\\s*(" + MON + ")?\\s*(?:al|a|hasta el|hasta|-)\\s*(\\d{1,2})(?:\\s*de)?\\s*(" + MON + ")(?:\\s*(?:de|del)?\\s*(\\d{4}))?"));
      if (!m) return null;
      d1 = +m[1]; d2 = +m[3]; m2 = MESES[m[4]]; m1 = m[2] ? MESES[m[2]] : m2; y1 = y2 = m[5] ? +m[5] : null;
    }
    let ya = y1 || y2 || yHoy;
    if (!valid(ya, m1, d1)) return null;
    let entrada = key(ya, m1, d1);
    if (!y1 && !y2 && entrada < hoy) { ya++; if (!valid(ya, m1, d1)) return null; entrada = key(ya, m1, d1); }
    let yb = y2 || ya;
    if (!valid(yb, m2, d2)) return null;
    let salida = key(yb, m2, d2);
    if (salida <= entrada && !y2) { yb++; if (!valid(yb, m2, d2)) return null; salida = key(yb, m2, d2); }
    if (salida <= entrada) return null;
    if (entrada < hoy) return { error: "pasado" };
    return { entrada, salida };
  }

  async function disp(entrada, salida, personas) {
    const r = await fetch("http://127.0.0.1:" + PORT + "/api/disponibilidad?entrada=" + entrada + "&salida=" + salida + "&personas=" + (personas || 0));
    return r.json();
  }

  /* ---------- textos ---------- */
  const REGLAS_MASCOTA =
    "🐾 Se acepta *una* mascota por unidad. Recordá las normas de estadía:\n" +
    "• Tiene que traer su propia cama y recipientes de comida y agua.\n" +
    "• No puede subirse a camas, colchones ni sillones.\n" +
    "• Si deja pelos, olores o manchas que requieran limpieza especial, se cobra USD 100.";
  const textoCarga = (enTemp) =>
    "⚡ Potencia: 1,8 a 2,2 kW (carga lenta).\n" +
    (enTemp ? "En verano la carga es gratuita." : "Fuera de verano cuesta $300 UYU por carga completa.") +
    "\nHay que coordinarla con nosotros antes de la estadía.";

  function resumen(s, from) {
    const d = s.d, r = d.r || {};
    return [
      "📋 Consulta nueva por WhatsApp",
      "Cliente: https://wa.me/" + from,
      "Fechas: " + fmtLargo(d.entrada) + " al " + fmtLargo(d.salida) + " (" + (r.noches || "?") + " noches)",
      "Personas: " + (d.personas || "?"),
      "Casa: " + (d.casaNombre || "sin elegir"),
      "Mascota: " + ({ no: "no", una: "una", mas: "más de una" }[d.mascota] || "sin dato"),
      "Carga eléctrica: " + (d.carga === "si" ? "sí" : d.carga === "no" ? "no" : "sin dato"),
      "Playa: " + (d.playa === "si" ? "sí, " + (d.sillas || "?") + " sillas" : d.playa === "no" ? "no" : "no aplica"),
      "Precio informado: " + (r.precioTotal ? "USD " + r.precioTotal.usd + " / $" + r.precioTotal.uyu : "a confirmar"),
    ].join("\n");
  }
  async function avisarDueno(msg) {
    if (OWNER) await text(OWNER, msg);
  }

  /* ---------- conversación ---------- */
  async function preguntar(to, s) {
    const d = s.d, r = d.r || {};
    switch (s.step) {
      case "fechas":
        return text(to, "¿Para qué fechas buscás? Escribilo así: *3 al 12 de diciembre* 📅");
      case "personas":
        return list(to, "¿Cuántas personas son?", "Elegir cantidad",
          [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => ["p_" + n, n + (n === 1 ? " persona" : " personas")]));
      case "casa": {
        const libres = (r.casas || []).filter(c => c.libre && c.entraLaGente);
        return list(to, "¡Buenas noticias! Para " + fmt(d.entrada) + " al " + fmt(d.salida) + " hay " + (libres.length === 1 ? "1 casa libre" : libres.length + " casas libres") + ". ¿Cuál querés ver?",
          "Elegir casa", libres.map(c => ["c_" + c.id, c.nombre, (c.capacidad ? "Hasta " + c.capacidad + " personas" : "") + (c.dormitorios ? " · " + c.dormitorios + " dorm." : "")]));
      }
      case "fotos":
        return buttons(to, "¿Querés ver las fotos y comodidades de " + d.casaNombre + "?", [["fotos_si", "Sí, mostrame"], ["fotos_no", "Ahora no"]]);
      case "mascota":
        return buttons(to, "¿Venís con mascota? 🐾 (se acepta una sola)", [["m_no", "No"], ["m_una", "Sí, una"], ["m_mas", "Más de una"]]);
      case "m_mas":
        return buttons(to, "Solo aceptamos *una* mascota por unidad. ¿Cómo seguimos?", [["m_ok", "Vengo con una"], ["humano", "Hablar con alguien"]]);
      case "carga":
        return buttons(to, "¿Durante tu estadía vas a necesitar utilizar nuestra estación de carga para vehículos eléctricos? ⚡", [["ev_si", "Sí, voy a usarla"], ["ev_no", "No, gracias"]]);
      case "playa":
        return buttons(to, "🏖️ En verano ofrecemos servicio de playa: hasta 4 sillas y una sombrilla por casa. ¿Lo querés incluir?", [["pl_si", "Sí"], ["pl_no", "No"]]);
      case "sillas":
        return list(to, "¿Cuántas sillas necesitás?", "Elegir sillas", [1, 2, 3, 4].map(n => ["s_" + n, n + (n === 1 ? " silla" : " sillas")]));
      case "precio": {
        const L = ["✅ *Resumen*", d.casaNombre + " · " + fmt(d.entrada) + " al " + fmt(d.salida) + " (" + r.noches + " noches) · " + d.personas + " personas"];
        if (r.precioTotal) L.push("💰 Total: *USD " + r.precioTotal.usd + "* (aprox. $ " + r.precioTotal.uyu + ")");
        else L.push("💰 El precio para esas fechas te lo confirmamos enseguida.");
        if (d.playa === "si") L.push("🏖️ Servicio de playa incluido (" + d.sillas + " sillas y sombrilla).");
        if (d.carga === "si") L.push(r.enTemporada ? "⚡ Carga eléctrica: gratuita en verano." : "⚡ Carga eléctrica: $300 UYU por carga completa, aparte.");
        L.push("\n¿Querés reservar ahora?");
        return buttons(to, L.join("\n"), [["reservar", "Reservar ahora"], ["duda", "Tengo una duda"], ["ahora_no", "Ahora no"]]);
      }
      default:
        return text(to, "Escribí *hola* para empezar. 🙂");
    }
  }

  async function calcular(to, s) {
    const d = s.d;
    const r = await disp(d.entrada, d.salida, d.personas);
    if (r.error) { s.step = "fechas"; await text(to, r.error); return preguntar(to, s); }
    d.r = { noches: r.noches, enTemporada: r.enTemporada, precioTotal: r.precioTotal, sena: r.sena, casas: r.casas, minimo: r.minimoNoches };
    if (!r.cumpleMinimo) {
      s.step = "fechas";
      await text(to, "Para esas fechas la estadía mínima es de *" + r.minimoNoches + " noches*. ¿Querés probar con otras fechas?");
      return preguntar(to, s);
    }
    const libres = r.casas.filter(c => c.libre && c.entraLaGente);
    if (libres.length) { s.step = "casa"; return preguntar(to, s); }
    d.alts = r.alternativas || [];
    if (d.alts.length) {
      s.step = "alternativas";
      const rows = d.alts.map((a, i) => ["a_" + i, fmt(a.entrada) + " al " + fmt(a.salida), a.casasLibres.join(", ")]);
      rows.push(["otras", "Probar otras fechas"], ["humano", "Hablar con alguien"]);
      return list(to, "Para esas fechas no tenemos casas libres para " + d.personas + " personas 😕. Pero estas fechas cercanas sí tienen lugar:", "Ver fechas", rows);
    }
    s.step = "fechas";
    await text(to, "Para esas fechas no tenemos disponibilidad 😕. Probá con otras fechas o escribí *hablar con alguien*.");
    return preguntar(to, s);
  }

  async function derivar(to, s) {
    s.step = "humano";
    await text(to, "Perfecto, te paso con una persona del equipo. Te escribe a la brevedad. 🙌");
    await avisarDueno("🙋 Un cliente pidió hablar con una persona\n" + resumen(s, to));
    addLead({ tipo: "humano", cliente: to, d: s.d });
  }

  async function handle(from, input) {
    const now = Date.now();
    let s = sessions[from];
    if (!s || now - s.ts > 48 * 3600 * 1000) s = sessions[from] = { step: "inicio", d: {}, ts: now };
    s.ts = now;
    const txt = (input.text || "").trim(), low = norm(txt), id = input.id || "";

    if (/^(menu|reiniciar|empezar|inicio)$/.test(low) || id === "reiniciar") { s.step = "inicio"; s.d = {}; }
    if (s.step === "humano" && !/^(hola|menu)$/.test(low)) { save(); return; } // lo atiende una persona
    if (s.step === "humano") { s.step = "inicio"; s.d = {}; }
    if (id === "humano" || /(hablar con (alguien|una persona|un humano|el due)|quiero hablar|asesor)/.test(low)) { await derivar(from, s); save(); return; }

    const d = s.d;
    switch (s.step) {
      case "inicio":
      case "fechas":
      case "alternativas": {
        if (s.step === "alternativas" && id.startsWith("a_")) {
          const a = (d.alts || [])[+id.slice(2)];
          if (a) { d.entrada = a.entrada; d.salida = a.salida; await calcular(from, s); break; }
        }
        if (id === "otras") { s.step = "fechas"; await preguntar(from, s); break; }
        const p = parseDates(txt);
        if (p && p.error) { await text(from, "Esa fecha ya pasó. ¿Para qué fechas buscás?"); break; }
        if (p) {
          const saludo = s.step === "inicio";
          d.entrada = p.entrada; d.salida = p.salida;
          await text(from, (saludo ? "¡Hola! Soy el asistente de *Casitas Atlántida* 🏖️\n" : "") + "Anoto: *" + fmtLargo(p.entrada) + " al " + fmtLargo(p.salida) + "*.");
          s.step = "personas"; await preguntar(from, s);
        } else if (s.step === "inicio") {
          await text(from, "¡Hola! Soy el asistente de *Casitas Atlántida* 🏖️ Te ayudo a encontrar casa y reservar.");
          s.step = "fechas"; await preguntar(from, s);
        } else {
          await text(from, "No pude entender las fechas. Probá así: *3 al 12 de diciembre* o *03/12 al 12/12*.");
        }
        break;
      }
      case "personas": {
        const n = id.startsWith("p_") ? +id.slice(2) : parseInt(txt, 10);
        if (!n || n < 1 || n > 20) { await preguntar(from, s); break; }
        d.personas = n; await calcular(from, s); break;
      }
      case "casa": {
        const c = id.startsWith("c_") ? (d.r.casas || []).find(x => "c_" + x.id === id) : null;
        if (!c) { await preguntar(from, s); break; }
        d.casa = c.id; d.casaNombre = c.nombre; s.step = "fotos"; await preguntar(from, s); break;
      }
      case "fotos": {
        if (id !== "fotos_si" && id !== "fotos_no") { await preguntar(from, s); break; }
        if (id === "fotos_si") await text(from, "📸 Fotos y comodidades de " + d.casaNombre + ":\n" + SITE + "/?casa=" + d.casa + "\n\nCuando termines de mirar, seguimos acá. 😊");
        s.step = "mascota"; await preguntar(from, s); break;
      }
      case "mascota":
      case "m_mas": {
        if (id === "m_no") d.mascota = "no";
        else if (id === "m_una" || id === "m_ok") d.mascota = "una";
        else if (id === "m_mas") { d.mascota = "mas"; s.step = "m_mas"; await preguntar(from, s); break; }
        else { await preguntar(from, s); break; }
        if (d.mascota === "una") await text(from, REGLAS_MASCOTA);
        s.step = "carga"; await preguntar(from, s); break;
      }
      case "carga": {
        if (id !== "ev_si" && id !== "ev_no") { await preguntar(from, s); break; }
        d.carga = id === "ev_si" ? "si" : "no";
        if (d.carga === "si") await text(from, textoCarga(d.r.enTemporada));
        s.step = d.r.enTemporada ? "playa" : "precio"; d.playa = d.r.enTemporada ? undefined : "na";
        await preguntar(from, s); break;
      }
      case "playa": {
        if (id === "pl_no") { d.playa = "no"; s.step = "precio"; }
        else if (id === "pl_si") { d.playa = "si"; s.step = "sillas"; }
        await preguntar(from, s); break;
      }
      case "sillas": {
        if (!id.startsWith("s_")) { await preguntar(from, s); break; }
        d.sillas = +id.slice(2); s.step = "precio"; await preguntar(from, s); break;
      }
      case "precio": {
        if (id === "reservar") {
          const r = d.r, se = r.sena;
          let msg = se
            ? "¡Genial! Para reservar, la seña equivale a una noche de estadía: *USD " + se.usd + "* (aprox. $ " + se.uyu + ").\n\n"
            : "¡Genial! La seña equivale a una noche de estadía; te confirmamos el monto enseguida.\n\n";
          try {
            const pm = await (await fetch("http://127.0.0.1:" + PORT + "/api/medios-de-pago?formato=texto")).text();
            msg += "💳 Podés pagarla así:\n" + pm + "\n\n";
          } catch (e) {}
          msg += "Cuando hagas el pago, mandame el *comprobante* por acá y te confirmamos la reserva. 🙌";
          await text(from, msg);
          await avisarDueno("🟢 Quiere RESERVAR (esperando seña)\n" + resumen(s, from));
          addLead({ tipo: "reservar", cliente: from, d });
          s.step = "comprobante";
        } else if (id === "duda") { await derivar(from, s); }
        else if (id === "ahora_no") { await text(from, "¡Sin problema! Cuando quieras retomar, escribí *hola*. Gracias por consultar. 🌴"); s.step = "inicio"; s.d = {}; }
        else await preguntar(from, s);
        break;
      }
      case "comprobante": {
        await text(from, "¡Gracias! Recibimos tu mensaje. Una persona del equipo confirma la reserva en cuanto vea la seña. 🙏");
        await avisarDueno("💵 Llegó un mensaje de " + "https://wa.me/" + from + " tras pedir la reserva (" + (input.media ? "adjuntó un archivo/imagen, probablemente el comprobante" : "texto: " + cut(txt, 200)) + ")\nRevisalo en la app.");
        s.step = "humano"; break;
      }
      default:
        s.step = "inicio";
    }
    save();
  }

  /* ---------- webhook ---------- */
  app.get("/webhook/whatsapp", (req, res) => {
    if (VERIFY && req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === VERIFY) return res.status(200).send(String(req.query["hub.challenge"]));
    res.sendStatus(403);
  });

  const seen = new Map();
  setInterval(() => { const t = Date.now() - 3600 * 1000; for (const [k, v] of seen) if (v < t) seen.delete(k); }, 10 * 60 * 1000).unref();

  app.post("/webhook/whatsapp", (req, res) => {
    if (APP_SECRET) {
      const sig = String(req.get("x-hub-signature-256") || "");
      const exp = "sha256=" + crypto.createHmac("sha256", APP_SECRET).update(req.rawBody || Buffer.alloc(0)).digest("hex");
      const ok = sig.length === exp.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp));
      if (!ok) return res.sendStatus(401);
    }
    res.sendStatus(200);
    try {
      for (const e of (req.body.entry || [])) for (const ch of (e.changes || [])) {
        for (const m of ((ch.value || {}).messages || [])) {
          if (seen.has(m.id)) continue;
          seen.set(m.id, Date.now());
          let input = {};
          if (m.type === "text") input = { text: m.text.body };
          else if (m.type === "interactive") {
            const i = m.interactive || {};
            const rep = i.button_reply || i.list_reply || {};
            input = { id: rep.id, text: rep.title };
          } else input = { media: true };
          handle(m.from, input).catch(err => console.error("[wa] error", err));
        }
      }
    } catch (err) { console.error("[wa] webhook", err); }
  });

  app.get("/api/admin/leads", checkAuth, (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(LEADS_FILE, "utf-8"))); } catch (e) { res.json([]); }
  });

  console.log("[wa] asistente de WhatsApp " + (TOKEN && PHONE_ID ? "activo" : "sin configurar (faltan WA_TOKEN / WA_PHONE_ID)"));
  return { parseDates, handle };
};
