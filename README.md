# Casitas Atlántida — Sitio web + panel de administración

## Qué es esto

Un sitio web completo para tu negocio de alquiler, con:
- Galería de 4 casitas al estilo Tesla
- Calendario de disponibilidad por casita (editable desde el panel)
- Panel de administración con contraseña (editar fotos, descripciones, precios, medios de pago)
- Subida real de fotos desde el celular o la PC
- Botón de WhatsApp con mensaje prellenado
- Todo guardado en el servidor → cualquier cambio se ve al instante para todos los visitantes

---

## Requisitos

- **Node.js 18 o superior** — descargalo desde https://nodejs.org (elegí la versión LTS)
- Una terminal (en Windows: PowerShell o CMD; en Mac/Linux: Terminal)

---

## Instalación local (para probar en tu PC antes de publicar)

```bash
# 1. Entrá a la carpeta del proyecto
cd casitas-atlantida

# 2. Instalá las dependencias (solo la primera vez)
npm install

# 3. Iniciá el servidor
npm start
```

Luego abrí tu navegador en: **http://localhost:3000**

El panel de administración está en el ícono ⚙ abajo a la derecha.
- Contraseña inicial: `atlantida2026` — **cambiala** desde el panel en Datos del negocio.

---

## Publicación en internet (opciones recomendadas)

### Opción A — Railway (la más fácil, gratis para empezar)

1. Creá una cuenta en https://railway.app
2. Hacé clic en "New Project" → "Deploy from GitHub repo"
3. Subí la carpeta `casitas-atlantida` a un repositorio en GitHub
4. Railway detecta automáticamente que es Node y lo publica
5. En "Settings" → "Networking" asignás un dominio gratuito (ej: casitas-atlantida.up.railway.app)

### Opción B — Render (también gratis para empezar)

1. Creá una cuenta en https://render.com
2. "New" → "Web Service" → conectá tu repositorio de GitHub
3. Build Command: `npm install`
4. Start Command: `npm start`
5. Render te da una URL pública automáticamente

### Opción C — VPS propio (DigitalOcean, Contabo, etc.)

```bash
# En el servidor
git clone <tu-repo> casitas-atlantida
cd casitas-atlantida
npm install
npm install -g pm2         # para que el servidor no se caiga
pm2 start server.js --name casitas
pm2 save
pm2 startup
```

Configurá nginx como reverse proxy apuntando al puerto 3000.

---

## Estructura de archivos

```
casitas-atlantida/
├── server.js          ← el backend (no tocar si no sabés Node)
├── package.json       ← dependencias
├── data/
│   └── config.json    ← toda la configuración del sitio (se edita desde el panel)
└── public/
    ├── index.html     ← el sitio web
    └── uploads/       ← fotos subidas desde el panel (se crean solas)
```

---

## Cómo editar el sitio (sin tocar código)

Todo se hace desde el panel ⚙:

| Tarea | Dónde |
|---|---|
| Cambiar foto principal de una casita | Panel → Casitas → Foto principal |
| Agregar fotos a la galería | Panel → Casitas → Galería (subir archivo o pegar link) |
| Tachar/marcar fechas ocupadas | Abrí la casita → tocá los días en el calendario |
| Cambiar precio o descripción | Panel → Casitas |
| Editar medios de pago | Panel → Medios de pago |
| Cambiar número de WhatsApp | Panel → Datos del negocio |
| Cambiar contraseña | Panel → Datos del negocio → Cambiar contraseña |
| Descargar copia de seguridad | Panel → Copia de seguridad |

---

## Notas importantes

- Las fotos subidas se guardan en `public/uploads/`. Si migrás de servidor, copiá esa carpeta.
- El archivo `data/config.json` tiene toda la configuración. Guardá una copia de seguridad periódica desde el panel.
- El sitio no usa base de datos: toda la información vive en ese archivo JSON. Para un negocio de 4 casitas administrado por una persona, es más que suficiente.
- Si algún día necesitás múltiples usuarios o reservas automáticas, se puede evolucionar el sistema.
