# Sistema de Actas Mexicanas

Portal para solicitar y gestionar actas de nacimiento digitales.

## Stack

- **Backend**: Node.js + Express
- **Base de datos**: Supabase (PostgreSQL + Storage)
- **Pagos**: MercadoPago
- **Hosting**: Render
- **Repo**: GitHub

---

## PASO 1 — Supabase (base de datos)

### 1.1 Crear las tablas

1. Ve a [supabase.com](https://supabase.com) → tu proyecto → **SQL Editor**
2. Clic en **New Query**
3. Copia y pega el contenido de `sql/schema.sql`
4. Clic en **Run**

### 1.2 Crear el bucket de Storage

1. En Supabase → **Storage** → **New Bucket**
2. Nombre: `actas`
3. Activa **Public bucket** ✓ (los usuarios deben poder descargar su PDF)
4. Clic en **Save**

---

## PASO 2 — GitHub (repositorio)

```bash
# En tu máquina, dentro de la carpeta del proyecto:
git init
git add .
git commit -m "feat: proyecto inicial"

# Crea un repo en GitHub (github.com/new) y luego:
git remote add origin https://github.com/TU_USUARIO/actas-mexicanas.git
git branch -M main
git push -u origin main
```

---

## PASO 3 — Render (hosting)

1. Ve a [render.com](https://render.com) → **New** → **Web Service**
2. Conecta tu repositorio de GitHub
3. Configuración:
   - **Name**: `sistema-actas-mexicanas`
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. En **Environment Variables**, agrega:

| Variable | Valor |
|---|---|
| `SUPABASE_URL` | `https://dzhwhcefqqmwowluztq.supabase.co` |
| `SUPABASE_SERVICE_ROLE` | Tu service role key |
| `MP_ACCESS_TOKEN` | Tu access token de MercadoPago |
| `MP_SANDBOX` | `true` (pruebas) o `false` (producción) |
| `JWT_SECRET` | Cadena aleatoria (mínimo 32 caracteres) |
| `ADMIN_EMAIL` | Correo del administrador |
| `ADMIN_PASSWORD` | Contraseña del administrador |
| `BACKEND_URL` | La URL que Render te asigne (la ves después del deploy) |
| `FRONTEND_URL` | La misma URL de Render |

5. Clic en **Create Web Service**
6. Espera que termine el build (~2 min)
7. Copia la URL que te asigna Render (ej: `https://sistema-actas-mexicanas.onrender.com`)
8. Actualiza `BACKEND_URL` y `FRONTEND_URL` con esa URL

---

## PASO 4 — Configurar Webhook de MercadoPago

Una vez que tengas la URL de Render:

1. Ve a [mercadopago.com.mx/developers](https://www.mercadopago.com.mx/developers)
2. **Tu aplicación** → **Webhooks**
3. Agrega la URL: `https://TU-APP.onrender.com/api/webhook/mercadopago`
4. Evento: **Pagos** ✓

---

## Estructura del proyecto

```
/
├── index.js           ← Backend principal (Express)
├── package.json
├── render.yaml        ← Config de despliegue
├── .env.example       ← Plantilla de variables de entorno
├── .gitignore
├── sql/
│   └── schema.sql     ← Ejecutar en Supabase SQL Editor
└── public/            ← Frontend (archivos HTML estáticos)
    ├── index.html         → Página principal (CURP + consulta)
    ├── seguimiento.html   → Estado del trámite
    ├── sin-tramites.html  → Sin trámites registrados
    └── admin/
        ├── login.html     → Login admin
        └── panel.html     → Panel de gestión
```

---

## Flujo completo

```
Usuario ingresa CURP
       ↓
Backend crea trámite (estado: pendiente_pago)
Backend crea preferencia en MercadoPago
       ↓
Usuario paga en MercadoPago
       ↓
MP llama webhook → estado: generando_acta
       ↓
Admin ve solicitud en panel
Admin sube PDF
       ↓
Estado → acta_lista
Usuario descarga PDF
```

---

## Desarrollo local

```bash
# Clonar e instalar
git clone https://github.com/TU_USUARIO/actas-mexicanas.git
cd actas-mexicanas
npm install

# Configurar variables de entorno
cp .env.example .env
# Edita .env con tus valores reales

# Iniciar servidor
npm run dev
# → http://localhost:3000
```
