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
const { AsyncLocalStorage } = require("async_hooks");
const phoneCtx = new AsyncLocalStorage(); // número de WhatsApp que recibió el mensaje (se responde desde el mismo)

module.exports = function mountWhatsApp(app, { readConfig, writeConfig, DATA_DIR, PORT, checkAuth, today }) {
  const TOKEN = process.env.WA_TOKEN || "";
  const PHONE_ID = process.env.WA_PHONE_ID || "";
  const VERIFY = process.env.WA_VERIFY_TOKEN || "";
  const APP_SECRET = process.env.WA_APP_SECRET || "";
  const OWNER = String(process.env.OWNER_WA || "").replace(/\D/g, "");
  const IGNORAR = new Set(String(process.env.WA_IGNORAR || "").split(/[,\s]+/).map(x => x.replace(/\D/g, "")).filter(Boolean));
  const SITE = (process.env.SITE_URL || "https://casitas-atlantida.onrender.com").replace(/\/$/, "");
  const graphUrl = () => "https://graph.facebook.com/v25.0/" + (phoneCtx.getStore() || PHONE_ID) + "/messages";

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
      const r = await fetch(graphUrl(), {
        method: "POST",
        headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify(Object.assign({ messaging_product: "whatsapp" }, body)),
      });
      if (!r.ok) console.error("[wa] error al enviar desde", phoneCtx.getStore() || PHONE_ID, r.status, (await r.text()).slice(0, 300));
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
  const NTFY = String(process.env.NTFY_TOPIC || "").trim();
  async function notificar(titulo, msg, click) {
    if (!NTFY) return;
    try {
      await fetch("https://ntfy.sh/", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic: NTFY, title: titulo, message: cut(msg, 3500), priority: 4, tags: ["house"], click: click || undefined }),
      });
    } catch (e) { console.error("[wa] no se pudo enviar la notificación", e.message); }
  }
  async function avisarDueno(msg, click, titulo) {
    await Promise.all([
      OWNER ? text(OWNER, msg + (click ? "\n" + click : "")) : null,
      notificar(titulo || "Casitas Atlántida", msg, click),
    ]);
  }

  /* ---------- bloqueo de fechas y confirmación por enlace ---------- */
  const dia = (k, n) => { const d = new Date(k + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  function bloquearFechas(casaId, entrada, salida) {
    const cfg = readConfig();
    cfg.availability = cfg.availability || {};
    const set = new Set(cfg.availability[casaId] || []);
    for (let k = entrada; k < salida; k = dia(k, 1)) set.add(k);
    cfg.availability[casaId] = [...set].sort();
    writeConfig(cfg);
  }
  const firma = c => crypto.createHmac("sha256", VERIFY || "sin-clave").update("confirmar:" + c).digest("hex").slice(0, 24);
  const urlConfirmar = c => SITE + "/wa-confirmar?c=" + c + "&k=" + firma(c);
  const CONF_FILE = path.join(DATA_DIR, "wa-confirmadas.json");
  const leerConf = () => { try { return JSON.parse(fs.readFileSync(CONF_FILE, "utf-8")); } catch (e) { return {}; } };

  const INTENCION = /(disponib|reserv|fecha|alquil|casita|precio|tarifa|libre|estad[ií]a|noches|cuanto sale|cuanto cuesta|semana|quincena)/;


  const envT = k => String(process.env[k] || "").replace(/\\n/g, "\n").trim();
  const NORMAS = "https://drive.google.com/file/d/1z5brQCMkLuB8cXDV9EDTqHZg4zdmCIAw/view";
  const MAPA_CASA3 = "https://maps.app.goo.gl/fVVYPUD3sChMaahK8?g_st=ic";
  const MAPA_OTRAS = "https://maps.app.goo.gl/Lpq2exrukpxQosmH7";

  function textoPago(tipo, d) {
    const falta = "Te enviamos los datos enseguida por acá.";
    if (tipo === "pay_brou") return "🏦 *Transferencia BROU*\n" + (envT("WA_PAGO_BROU") || falta);
    if (tipo === "pay_prex") return "🌎 *Prex* (Uruguay / Argentina / exterior)\n" + (envT("WA_PAGO_PREX") || falta);
    if (tipo === "pay_abitab") return "🏪 *Red de Cobranzas (Abitab o Redpagos)*\n" + (envT("WA_PAGO_ABITAB") || falta);
    const linkCasa = envT("WA_AIRBNB_CASA" + d.casa);
    const link = linkCasa || envT("WA_AIRBNB_LINK");
    return "💳 *Tarjeta de crédito vía Airbnb*\n" +
      (linkCasa ? "Publicación de *" + (d.casaNombre || "la casa") + "* en Airbnb:\n" : "Perfil de Casitas Atlántida en Airbnb:\n") + (link || "(te lo enviamos enseguida)") + "\n\n" +
      "⚠️ Airbnb cobra una comisión propia de la aplicación, de aproximadamente *19,6% adicional* sobre el precio directo.\n\n" +
      "Pasos:\n" +
      "1️⃣ Si todavía no tenés cuenta: descargá la app de Airbnb (App Store o Google Play) o entrá a airbnb.com.\n" +
      "2️⃣ Tocá *Registrarte* y creá tu usuario con email, teléfono, Google o Apple. Completá tu nombre y fecha de nacimiento, y confirmá tu email o teléfono.\n" +
      (linkCasa ? "3️⃣ Abrí el enlace de arriba: te lleva directo a la casa que elegiste.\n" : "3️⃣ Abrí el perfil de Casitas Atlántida con el enlace de arriba y elegí *" + (d.casaNombre || "la casa") + "*.\n") +
      "4️⃣ Seleccioná las fechas " + fmtLargo(d.entrada) + " al " + fmtLargo(d.salida) + " y pagá con tarjeta dentro de Airbnb.\n" +
      "5️⃣ Mandame por acá una captura de la reserva en Airbnb.";
  }
  const CIERRE_PAGO = "\n\nEnviando el *comprobante* (o la captura de la reserva en Airbnb) y la *foto del documento de identidad del huésped principal*, la reserva queda confirmada ✅";

  function detallesReserva(d) {
    const r = d.r || {};
    const num = (String(d.casaNombre || "").match(/\d+/) || [String(d.casa)])[0];
    const total = r.precioTotal ? "USD " + r.precioTotal.usd + " (aprox. $ " + r.precioTotal.uyu + ")" : "a confirmar";
    return [
      "¡Gracias por elegir Casitas Atlántida! 🏡", "",
      "✅ *DETALLES DE LA RESERVA*", "",
      "🏠 Casa: " + num,
      "📅 Entrada: " + fmtLargo(d.entrada) + " – desde 14:00 h",
      "📅 Salida: " + fmtLargo(d.salida) + " – hasta 10:00 h",
      "💰 Total: " + total, "",
      "🛏️ Incluye ropa de cama.",
      "🧴 Traer toallas personales.", "",
      "🚫 *CONDICIONES IMPORTANTES*", "",
      "• Alojamiento exclusivo para las personas declaradas.",
      "• No se permiten fiestas, eventos ni reuniones.",
      "• Las visitas requieren autorización previa de la administración, aunque no pernocten.", "",
      "✅ *ACEPTACIÓN:* El huésped declara conocer, aceptar y comprometerse a cumplir estas condiciones durante toda su estadía.", "",
      "📍 Ubicación: " + (num === "3" ? MAPA_CASA3 : MAPA_OTRAS), "",
      "📖 Normas de estadía: " + NORMAS,
    ].join("\n");
  }


  /* ---------- preguntas frecuentes (respuestas basadas en el reglamento de estadía) ---------- */
  const FAQ = [
    { id: "faq_normas", titulo: "Normas completas", desc: "Reglamento de estadía", re: /(normas|reglamento|reglas)/,
      r: "📖 Normas de estadía completas:\n" + NORMAS },
    { id: "faq_ubicacion", titulo: "Ubicación y playa", desc: "Dónde estamos y qué tan cerca está la playa", re: /(ubicaci|direccion|donde (queda|esta|estan)|como (llego|llegar|se llega)|mapa|eden rock|(distancia|cerca|lejos|metros|cuadras).{0,30}playa|playa.{0,30}(cerca|lejos|distancia|metros|cuadras))/,
      r: "📍 *Ubicación* (Atlántida, Canelones)\n🏖️ Estamos a 300 metros de la playa, a pasitos de la playa Eden Rock, la más linda.\n• Casa 3: " + MAPA_CASA3 + "\n• Casas 1, 2 y 4: " + MAPA_OTRAS },
    { id: "faq_checkin", titulo: "Check-in e ingreso", desc: "Horarios, llaves e instrucciones de acceso", re: /(check.?in|check.?out|a que hora|horario de (llegada|salida|entrada|ingreso)|hora de (llegada|salida|entrada|ingreso)|ingreso|llaves|como entro|instrucciones de acceso)/,
      r: "🕑 *Check-in y check-out*\n• Check-in: desde las 14:00 h.\n• Check-out: hasta las 10:00 h.\nSi necesitás otro horario, consultanos antes y lo coordinamos. Quedarse después del horario de salida sin autorización puede generar cargos adicionales.\n\n🔑 *Ingreso*\nUnos días antes de tu llegada te enviamos las instrucciones de acceso a la casa, siempre que la seña esté paga. Si el pago se hace al ingresar, coordinamos la entrega de las llaves contra el pago." },
    { id: "faq_mascotas", titulo: "Mascotas", desc: "Qué normas hay", re: /(mascota|perro|gato|perrito)/,
      r: "🐾 *Mascotas*\nSe acepta *una* mascota por unidad, avisando al reservar.\n• Tiene que traer su propia cama y recipientes de comida y agua.\n• No puede subirse a camas, colchones ni sillones.\n• Si deja pelos, olores o manchas que requieran limpieza especial, se cobra USD 100." },
    { id: "faq_equipamiento", titulo: "Equipamiento", desc: "Wifi, aire, cocina y parrillero", re: /(wifi|wi-fi|internet|\baire\b|climatizacion|calefaccion|cocina|heladera|microondas|tostadora|utensilios|vajilla|parrillero|parrilla|barbacoa|horno de le)/,
      r: "🏡 *Equipamiento*\n• Wifi de alta velocidad.\n• Aire acondicionado en todas las casas. Son casas modernas que aíslan muy bien la temperatura exterior.\n• Cocina equipada: cocina a gas, heladera, tostadora, microondas y todos los utensilios necesarios para cocinar.\n• Parrillero independiente en cada casa.\n• La Casa 3 además tiene barbacoa cerrada con horno de leña.\n\n❄️ Pedimos usar el aire con responsabilidad: en invierno entre 21 y 23 °C, en verano entre 24 y 26 °C, con puertas y ventanas cerradas." },
    { id: "faq_cancelaciones", titulo: "Cancelaciones y cambios", desc: "Reprogramación de la reserva", re: /(cancel|reprogram|reembols|devoluc|devuelven|no puedo viajar|imprevisto)/,
      r: "🔄 *Cancelaciones y cambios*\n• Avisanos con la mayor anticipación posible.\n• En casos de fuerza mayor se puede *reprogramar* la reserva, según disponibilidad.\n• La seña no se reembolsa, pero se ofrece la reprogramación.\nCualquier cambio de fechas o de cantidad de huéspedes se comunica y se autoriza antes." },
    { id: "faq_incluye", titulo: "Qué incluye", desc: "Ropa de cama, playa, carga eléctrica", re: /(que incluye|incluye|ropa de cama|sabanas|toalla|sombrilla|sillas de playa|servicio de playa|carga (de )?(auto|vehiculo)|estacion de carga|auto electrico)/,
      r: "🛏️ *Qué incluye*\n• Ropa de cama.\n• Luz y agua, con uso razonable.\n• Servicio de playa en verano: hasta 4 sillas y una sombrilla por casa.\n🧴 Traé tus toallas personales.\n⚡ Estación de carga para vehículos eléctricos: 1,8 a 2,2 kW (carga lenta). En verano es gratuita; fuera de verano cuesta $300 UYU por carga completa. Se coordina con nosotros antes de la estadía." },
    { id: "faq_estacionamiento", titulo: "Estacionamiento", desc: "Dónde dejar el auto", re: /(estacionamiento|cochera|garage|parking|donde (dejo|estaciono))/,
      r: "🚗 *Estacionamiento*\nHay estacionamiento privado para los huéspedes y los vehículos informados. No se pueden bloquear accesos ni usar espacios de otras unidades. No nos hacemos responsables por objetos dejados dentro de los vehículos." },
    { id: "faq_ruidos", titulo: "Ruidos, visitas y fumar", desc: "Normas de convivencia", re: /(fiesta|evento|ruido|visita|fumar|cigarr|horario de descanso|silencio)/,
      r: "🤫 *Convivencia*\n• Horario de descanso: de 23:00 a 08:00 h.\n• No se permiten fiestas, eventos ni reuniones.\n• Solo se alojan las personas declaradas en la reserva; las visitas requieren autorización previa, aunque no pernocten.\n• Está prohibido fumar dentro de las viviendas." },
    { id: "faq_pago", titulo: "Seña y formas de pago", desc: "Cómo se confirma la reserva", re: /(sena|medios? de pago|formas? de pago|como (pago|abono)|transferencia|cuenta bancaria|tarjeta)/,
      r: "💳 *Seña y formas de pago*\nLa seña equivale al valor de *una noche*. Podés pagarla con:\n• Tarjeta de crédito vía Airbnb (Airbnb suma una comisión propia de aprox. 19,6%).\n• Transferencia BROU.\n• Prex (Uruguay, Argentina y exterior).\n• Abitab o Redpagos.\nLa reserva queda confirmada al enviar el comprobante y la foto del documento del huésped principal. Para empezar, escribí *reservar*." },
  ];
  const FAQ_MENU = /^(preguntas( frecuentes)?|ayuda|info|informacion|menu de preguntas)$/;
  const responderFaq = async (to, f) => {
    await text(to, f.r);
    await buttons(to, "¿Te ayudo con algo más?", [["faq_menu", "Más preguntas"], ["consultar", "Consultar fechas"], ["humano", "Hablar con alguien"]]);
  };
  const menuFaq = (to) => list(to, "Estas son las consultas más frecuentes. ¿Sobre qué querés saber?", "Ver preguntas", FAQ.map(f => [f.id, f.titulo, f.desc]));

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
      case "pago": {
        const se = r.sena;
        return list(to, "Para confirmar la reserva solicitamos seña del valor de una noche" + (se ? ": *USD " + se.usd + "* (aprox. $ " + se.uyu + ")" : "") + ".\n\n¿Cómo preferís pagarla?", "Elegir forma de pago", [
          ["pay_airbnb", "Tarjeta (Airbnb)", "Tarjeta de crédito vía Airbnb"],
          ["pay_brou", "Transferencia BROU", "Cuenta en pesos o dólares"],
          ["pay_prex", "Prex", "Uruguay, Argentina y exterior"],
          ["pay_abitab", "Abitab o Redpagos", "Giro por Red de Cobranzas"],
        ]);
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
    await avisarDueno("🙋 Un cliente pidió hablar con una persona\n" + resumen(s, to), "https://wa.me/" + to, "Pidió hablar con vos");
    addLead({ tipo: "humano", cliente: to, d: s.d });
  }

  async function handle(from, input) {
    const now = Date.now();
    let s = sessions[from];
    if (!s || now - s.ts > 48 * 3600 * 1000) s = sessions[from] = { step: "inicio", d: {}, ts: now };
    s.ts = now;
    const txt = (input.text || "").trim(), low = norm(txt), id = input.id || "";
    if (IGNORAR.has(from)) return;

    let reinicio = false;
    if (/^(menu|reiniciar|empezar|inicio)$/.test(low) || id === "reiniciar") { s.step = "inicio"; s.d = {}; reinicio = true; }
    if (input.audio) {
      if (s.step === "humano") { save(); return; }
      await buttons(from, "No puedo escuchar audios 🙏 ¿Me lo escribís por acá? O elegí una opción:", [["reiniciar", "Ver menú"], ["humano", "Hablar con alguien"]]);
      await avisarDueno("🎤 Te mandó un audio: https://wa.me/" + from + " (el bot no puede escucharlo).", "https://wa.me/" + from, "Audio recibido");
      save(); return;
    }
    if (s.step === "humano") { save(); return; } // lo atiende una persona; el cliente puede escribir "menu" para volver al asistente
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
        if (s.step === "inicio") {
          if (id === "faq_menu" || (!id && FAQ_MENU.test(low))) { await menuFaq(from); break; }
          const f = id.startsWith("faq_") ? FAQ.find(x => x.id === id)
            : (!id && !reinicio && !INTENCION.test(low) && !parseDates(txt)) ? FAQ.find(x => x.re.test(low)) : null;
          if (f) { await responderFaq(from, f); break; }
        }
        const p = parseDates(txt);
        if (p && p.error) { await text(from, "Esa fecha ya pasó. ¿Para qué fechas buscás?"); break; }
        if (p) {
          const saludo = s.step === "inicio";
          d.entrada = p.entrada; d.salida = p.salida;
          await text(from, (saludo ? "¡Hola! Soy el asistente de *Casitas Atlántida* 🏖️\n" : "") + "Anoto: *" + fmtLargo(p.entrada) + " al " + fmtLargo(p.salida) + "*.");
          s.step = "personas"; await preguntar(from, s);
        } else if (s.step === "inicio") {
          if (id === "consultar" || reinicio || INTENCION.test(low)) {
            await text(from, "¡Hola! Soy el asistente de *Casitas Atlántida* 🏖️ Te ayudo a encontrar casa y reservar.");
            s.step = "fechas"; await preguntar(from, s);
          } else if (process.env.WA_SALUDO !== "no") {
            await buttons(from, "¡Hola! Soy el asistente de *Casitas Atlántida* 🏖️ ¿En qué te ayudo?", [["consultar", "Consultar fechas"], ["faq_menu", "Preguntas frecuentes"], ["humano", "Hablar con alguien"]]);
          }
          // con WA_SALUDO=no, un mensaje sin intención de reserva no recibe respuesta automática (lo atendés vos)
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
          s.step = "pago";
          await avisarDueno("🟢 Quiere RESERVAR (eligiendo forma de pago)\n" + resumen(s, from), "https://wa.me/" + from, "Quiere reservar");
          addLead({ tipo: "reservar", cliente: from, d });
          await preguntar(from, s);
        } else if (id === "duda") { await derivar(from, s); }
        else if (id === "ahora_no") { await text(from, "¡Sin problema! Cuando quieras retomar, escribí *hola*. Gracias por consultar. 🌴"); s.step = "inicio"; s.d = {}; }
        else await preguntar(from, s);
        break;
      }
      case "pago":
      case "comprobante": {
        if (id === "cambiar_pago" || (s.step === "comprobante" && /(cambiar|cambio|otra|otro).{0,25}(forma|metodo|medio|pago|pagar)|pagar de otra|otra manera de pagar/.test(low))) {
          s.step = "pago"; await preguntar(from, s); break;
        }
        if (id.startsWith("pay_")) {
          d.pago = id; d.docs = d.docs || 0; s.step = "comprobante";
          await text(from, textoPago(id, d) + CIERRE_PAGO);
          await buttons(from, "¿Preferís otra forma de pago?", [["cambiar_pago", "Cambiar forma de pago"]]);
          await avisarDueno("💳 Eligió pagar con: " + ({ pay_airbnb: "Airbnb", pay_brou: "Transferencia BROU", pay_prex: "Prex", pay_abitab: "Abitab/Redpagos" }[id]) + "\nhttps://wa.me/" + from);
          break;
        }
        if (s.step === "pago") { await preguntar(from, s); break; }
        if (!input.media) {
          // El recordatorio sale una sola vez; después el asistente se calla y te avisa lo que escribe el cliente.
          if (!d.recordado) {
            d.recordado = Date.now();
            await text(from, "Cuando los tengas, mandame por acá el *comprobante* y la *foto del documento de identidad del huésped principal*. 🙌\nSi tenés alguna duda, escribí *hablar con alguien* y te atiende una persona.");
          } else {
            await avisarDueno("💬 El cliente escribió mientras espera para reservar: \"" + cut(txt, 300) + "\"\n" + resumen(s, from), "https://wa.me/" + from, "Mensaje de un cliente");
          }
          break;
        }
        d.docs = (d.docs || 0) + 1;
        if (d.docs < 2) {
          await text(from, "Recibí 1 archivo ✅ Para confirmar necesito *los dos*: el comprobante de pago (o captura de Airbnb) y la foto del documento de identidad del huésped principal. Me falta 1 más.");
          await avisarDueno("📎 Llegó el primer archivo de https://wa.me/" + from + ". Falta el segundo (comprobante o documento).");
          break;
        }
        // Ya recibimos comprobante + documento
        let libre = true;
        try {
          const r2 = await disp(d.entrada, d.salida, d.personas);
          const c2 = (r2.casas || []).find(x => x.id === d.casa);
          libre = !!(c2 && c2.libre);
        } catch (e) {}
        addLead({ tipo: "documentacion", cliente: from, phoneId: phoneCtx.getStore() || PHONE_ID, d });
        if (!libre || process.env.WA_CONFIRMAR_AUTO === "no") {
          await text(from, "¡Gracias! Recibimos todo ✅ Estamos verificando y te confirmamos la reserva en breve. 🙏");
          if (libre) await avisarDueno("✅ Llegaron comprobante y documento. Revisá el pago y tocá este enlace para confirmar: se bloquean las fechas y el cliente recibe los detalles.\n" + resumen(s, from), urlConfirmar(from), "Reserva por confirmar");
          else await avisarDueno("⚠️ REVISAR: llegaron comprobante y documento pero la casa figura ocupada en esas fechas.\n" + resumen(s, from), "https://wa.me/" + from, "Revisar reserva");
        } else {
          await text(from, detallesReserva(d));
          try { bloquearFechas(d.casa, d.entrada, d.salida); } catch (e) { console.error("[wa] no se pudieron bloquear las fechas", e.message); }
          const cf = leerConf(); cf[from + ":" + d.entrada + ":" + d.salida] = new Date().toISOString();
          try { fs.writeFileSync(CONF_FILE, JSON.stringify(cf)); } catch (e) {}
          await avisarDueno("✅ RESERVA CONFIRMADA y fechas bloqueadas (Airbnb las toma en su próxima sincronización). Verificá el pago.\n" + resumen(s, from), "https://wa.me/" + from, "Reserva confirmada");
        }
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
        if (ch.field === "smb_message_echoes") {
          for (const m of ((ch.value || {}).message_echoes || [])) {
            const to = String(m.to || "").replace(/\D/g, "");
            if (!to) continue;
            sessions[to] = { step: "humano", d: {}, ts: Date.now() };
            console.log("[wa] respondiste vos a", to, "- el asistente se silencia con ese cliente");
          }
          save();
          continue;
        }
        for (const m of ((ch.value || {}).messages || [])) {
          if (seen.has(m.id)) continue;
          seen.set(m.id, Date.now());
          console.log("[wa] mensaje recibido de", m.from, "tipo", m.type, "en el número", ((ch.value || {}).metadata || {}).phone_number_id);
          let input = {};
          if (m.type === "text") input = { text: m.text.body };
          else if (m.type === "interactive") {
            const i = m.interactive || {};
            const rep = i.button_reply || i.list_reply || {};
            input = { id: rep.id, text: rep.title };
          } else if (m.type === "audio") input = { audio: true };
          else input = { media: true };
          phoneCtx.run(((ch.value || {}).metadata || {}).phone_number_id || PHONE_ID, () => handle(m.from, input)).catch(err => console.error("[wa] error", err));
        }
      }
    } catch (err) { console.error("[wa] webhook", err); }
  });


  // Ayuda de configuración: suscribe la app a una cuenta de WhatsApp Business y muestra su estado.
  // Se abre desde el navegador: /wa-setup?clave=TU_WA_VERIFY_TOKEN&waba=ID_DE_LA_CUENTA
  app.get("/wa-setup", async (req, res) => {
    res.set("X-Robots-Tag", "noindex");
    if (!VERIFY || req.query.clave !== VERIFY) return res.status(403).type("text/plain").send("Clave incorrecta.");
    const waba = String(req.query.waba || "").replace(/\D/g, "");
    if (!TOKEN) return res.type("text/plain").send("Falta la variable WA_TOKEN en Render.");
    if (!waba) return res.type("text/plain").send("Agregá &waba=ID_DE_LA_CUENTA a la dirección.");
    const g = async (method, p) => {
      const r = await fetch("https://graph.facebook.com/v25.0/" + p, { method, headers: { Authorization: "Bearer " + TOKEN } });
      return { estado: r.status, respuesta: await r.json().catch(() => ({})) };
    };
    const out = {};
    if (req.query.suscribir !== "no") out.suscribir_app = await g("POST", waba + "/subscribed_apps");
    out.apps_suscriptas = await g("GET", waba + "/subscribed_apps");
    out.numeros = await g("GET", waba + "/phone_numbers?fields=id,display_phone_number,verified_name,status,platform_type");
    res.type("application/json").send(JSON.stringify(out, null, 2));
  });

  app.get("/wa-confirmar", async (req, res) => {
    res.set("X-Robots-Tag", "noindex");
    const pag = (t, m) => res.type("html").send('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font:18px/1.5 -apple-system,sans-serif;max-width:520px;margin:48px auto;padding:0 20px"><h2>' + t + "</h2><p>" + m + "</p></body>");
    const c = String(req.query.c || "").replace(/\D/g, "");
    if (!c || String(req.query.k || "") !== firma(c)) return pag("Enlace no válido", "Este enlace no es correcto o está vencido.");
    let leads = [];
    try { leads = JSON.parse(fs.readFileSync(LEADS_FILE, "utf-8")); } catch (e) {}
    const lead = leads.filter(l => l.tipo === "documentacion" && l.cliente === c).pop();
    if (!lead) return pag("No encontré la reserva", "No hay una reserva pendiente para ese cliente.");
    const d = lead.d, clave = c + ":" + d.entrada + ":" + d.salida, cf = leerConf();
    if (cf[clave]) return pag("Ya estaba confirmada ✅", "Esta reserva ya se confirmó antes. No se envió nada de nuevo.");
    try {
      const r2 = await disp(d.entrada, d.salida, d.personas);
      const c2 = (r2.casas || []).find(x => x.id === d.casa);
      if (!(c2 && c2.libre)) return pag("Ojo: la casa figura ocupada ⚠️", "Esas fechas ya están ocupadas en tu calendario. No confirmé nada. Revisalo antes de avisarle al cliente.");
    } catch (e) {}
    try { bloquearFechas(d.casa, d.entrada, d.salida); } catch (e) { return pag("No pude bloquear las fechas", "Probá de nuevo en un rato."); }
    await phoneCtx.run(lead.phoneId || PHONE_ID, () => text(c, detallesReserva(d)));
    cf[clave] = new Date().toISOString();
    try { fs.writeFileSync(CONF_FILE, JSON.stringify(cf)); } catch (e) {}
    pag("Reserva confirmada ✅", "Bloqueé " + d.casaNombre + " del " + d.entrada + " al " + d.salida + " y le envié los detalles al cliente (+" + c + ").");
  });

  app.get("/api/admin/leads", checkAuth, (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync(LEADS_FILE, "utf-8"))); } catch (e) { res.json([]); }
  });

  console.log("[wa] asistente de WhatsApp " + (TOKEN && PHONE_ID ? "activo" : "sin configurar (faltan WA_TOKEN / WA_PHONE_ID)"));
  return { parseDates, handle };
};
