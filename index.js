/**
 * Sistema de Actas Mexicanas — Backend
 * Express + Supabase + MercadoPago
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');
const fs       = require('fs');
const jwt      = require('jsonwebtoken');
const crypto   = require('crypto');
const { createClient }                   = require('@supabase/supabase-js');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const compression = require('compression');
const slowDown    = require('express-slow-down');

// Web-push opcional (solo si están configuradas las VAPID keys)
let webpush = null;
let pushSubscriptions = [];
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  try {
    webpush = require('web-push');
    webpush.setVapidDetails(
      process.env.VAPID_EMAIL || 'mailto:reyalexis001@gmail.com',
      process.env.VAPID_PUBLIC_KEY,
      process.env.VAPID_PRIVATE_KEY
    );
    console.log('✅ Web Push configurado');
  } catch (e) {
    console.warn('⚠️  Web Push no disponible:', e.message);
  }
}

async function sendPushNotification(title, body) {
  if (!webpush || !pushSubscriptions.length) return;
  const payload = JSON.stringify({ title, body, url: '/admin/panel.html' });
  for (const sub of [...pushSubscriptions]) {
    try {
      await webpush.sendNotification(sub, payload);
    } catch (err) {
      if (err.statusCode === 410 || err.statusCode === 404) {
        pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== sub.endpoint);
      }
    }
  }
}

const app = express();

// ── CRÍTICO: trust proxy para que el rate limiter use la IP real del usuario ──
// Sin esto, todos los usuarios parecen la misma IP y se bloquean entre sí
app.set('trust proxy', 1);

// ── Compresión GZIP — reduce hasta 70% el tamaño de respuestas ──────────
app.use(compression({
  level: 6,
  threshold: 1024, // solo comprimir respuestas > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  }
}));

// ── Clientes externos ─────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE,
  {
    auth: { persistSession: false },
    db:   { schema: 'public' },
    global: {
      headers: { 'x-app': 'sistema-actas-mexicanas' },
      fetch: (url, opts = {}) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000); // timeout 8s
        return fetch(url, { ...opts, signal: controller.signal })
          .finally(() => clearTimeout(timer));
      }
    }
  }
);

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 12000, idempotencyKey: undefined }
});

// ── Upload de PDFs en memoria ─────────────────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo se permiten archivos PDF'));
  }
});

// ── Middleware global ─────────────────────────────────────────────────────
app.use(cors({
  origin: process.env.FRONTEND_URL || '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'x-cleanup-secret']
}));

app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));

// ── Rate Limiting ─────────────────────────────────────────────────────────
const limiterGeneral = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => ['/api/webhook/mercadopago', '/health', '/api/cleanup-auto'].includes(req.path),
  message: { error: 'Demasiadas peticiones. Intenta de nuevo en 15 minutos.' }
});

// Slow-down: en vez de bloquear, empieza a ralentizar respuestas
// después de 50 peticiones → añade 200ms por cada petición extra
// Así el servidor no se satura pero tampoco bloquea al usuario legítimo
const speedLimiter = slowDown({
  windowMs: 15 * 60 * 1000,
  delayAfter: 50,
  delayMs: (used) => (used - 50) * 200, // 200ms, 400ms, 600ms...
  maxDelayMs: 5000,                      // máximo 5 segundos de delay
  skip: (req) => ['/api/webhook/mercadopago', '/health', '/api/cleanup-auto'].includes(req.path)
});

const limiterTramite = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Límite de solicitudes alcanzado. Intenta de nuevo en una hora.' }
});

const limiterLogin = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Demasiados intentos de acceso. Intenta de nuevo en 15 minutos.' }
});

app.use(limiterGeneral);
app.use(speedLimiter);

// ── Frontend estático ─────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  etag: true
}));

// ── Health check ──────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ═════════════════════════════════════════════════════════════════════════
//  RUTAS PÚBLICAS — Trámites
// ═════════════════════════════════════════════════════════════════════════

const PRECIO_MXN = 10; // Precio único en todo el sistema

app.post('/api/tramite', limiterTramite, async (req, res) => {
  try {
    const { curp } = req.body;

    const curpRegex = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z\d]\d$/i;
    if (!curp || !curpRegex.test(curp.trim())) {
      return res.status(400).json({ error: 'CURP inválido. Verifica el formato (18 caracteres).' });
    }

    const curpUpper = curp.toUpperCase().trim();

    // ¿Ya existe un trámite activo para este CURP?
    const { data: existing } = await supabase
      .from('tramites')
      .select('id, estado')
      .eq('curp', curpUpper)
      .not('estado', 'eq', 'acta_lista')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (existing) {
      if (existing.estado === 'pendiente_pago') {
        // Reintentar pago
        try {
          const pref = new Preference(mpClient);
          const mpPref = await pref.create({
            body: {
              items: [{ title: 'Acta de Nacimiento Digital', quantity: 1, unit_price: PRECIO_MXN, currency_id: 'MXN' }],
              metadata: { tramite_id: existing.id, curp: curpUpper },
              external_reference: existing.id,
              back_urls: {
                success: `${process.env.FRONTEND_URL}/seguimiento.html?id=${existing.id}`,
                failure: `${process.env.FRONTEND_URL}/seguimiento.html?id=${existing.id}`
              },
              auto_return: 'approved',
              notification_url: `${process.env.BACKEND_URL}/api/webhook/mercadopago`
            }
          });
          const isSandbox = process.env.MP_SANDBOX === 'true';
          return res.json({
            tramite_id: existing.id,
            redirect_url: isSandbox ? mpPref.sandbox_init_point : mpPref.init_point,
            existing: true, retry: true
          });
        } catch (mpErr) {
          console.error('[Retry MP]', mpErr.message);
        }
      }
      return res.json({
        tramite_id: existing.id,
        redirect_url: null,
        existing: true
      });
    }

    // Crear nuevo trámite
    const { data: tramite, error: insertError } = await supabase
      .from('tramites')
      .insert({ curp: curpUpper, estado: 'pendiente_pago' })
      .select()
      .single();

    if (insertError) throw insertError;

    // Crear preferencia en MercadoPago
    const pref = new Preference(mpClient);
    const mpPref = await pref.create({
      body: {
        items: [{ title: 'Acta de Nacimiento Digital', quantity: 1, unit_price: PRECIO_MXN, currency_id: 'MXN' }],
        metadata: { tramite_id: tramite.id, curp: curpUpper },
        external_reference: tramite.id,
        back_urls: {
          success: `${process.env.FRONTEND_URL}/seguimiento.html?id=${tramite.id}`,
          failure: `${process.env.FRONTEND_URL}/seguimiento.html?id=${tramite.id}`
        },
        auto_return: 'approved',
        notification_url: `${process.env.BACKEND_URL}/api/webhook/mercadopago`
      }
    });

    await supabase.from('tramites').update({ preference_id: mpPref.id }).eq('id', tramite.id);

    const isSandbox = process.env.MP_SANDBOX === 'true';
    const checkoutUrl = isSandbox ? mpPref.sandbox_init_point : mpPref.init_point;
    console.log(`[MP] Preferencia ${mpPref.id} → ${checkoutUrl}`);

    res.json({ tramite_id: tramite.id, redirect_url: checkoutUrl, existing: false });

  } catch (err) {
    console.error('[POST /api/tramite]', err.message);
    res.status(500).json({ error: 'Error al crear el trámite. Intenta de nuevo.' });
  }
});

app.get('/api/tramite/curp/:curp', async (req, res) => {
  try {
    const curp = req.params.curp.toUpperCase().trim();
    const { data: tramites, error } = await supabase
      .from('tramites')
      .select('id, curp, estado, created_at, acta_url')
      .eq('curp', curp)
      .order('created_at', { ascending: false });

    if (error) throw error;
    if (!tramites?.length) return res.json({ found: false, tramites: [] });
    res.json({ found: true, tramites });
  } catch (err) {
    console.error('[GET tramite/curp]', err.message);
    res.status(500).json({ error: 'Error al consultar trámites.' });
  }
});

app.get('/api/tramite/id/:id', async (req, res) => {
  try {
    const { data: tramite, error } = await supabase
      .from('tramites')
      .select('id, curp, estado, created_at, acta_url')
      .eq('id', req.params.id)
      .single();

    if (error || !tramite) return res.status(404).json({ error: 'Trámite no encontrado.' });
    res.json(tramite);
  } catch (err) {
    console.error('[GET tramite/id]', err.message);
    res.status(500).json({ error: 'Error al consultar trámite.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
//  WEBHOOK — MercadoPago (sin rate limiting)
// ═════════════════════════════════════════════════════════════════════════

app.post('/api/webhook/mercadopago', async (req, res) => {
  // Validar firma si está configurada
  const xSignature = req.headers['x-signature'];
  const xRequestId = req.headers['x-request-id'];
  const secret     = process.env.MP_WEBHOOK_SECRET;

  if (secret && xSignature && xRequestId) {
    try {
      const parts   = xSignature.split(',');
      const ts      = parts.find(p => p.startsWith('ts='))?.split('=')[1];
      const sig     = parts.find(p => p.startsWith('v1='))?.split('=')[1];
      const manifest = `id:${req.body?.data?.id};request-id:${xRequestId};ts:${ts};`;
      const expected = crypto.createHmac('sha256', secret).update(manifest).digest('hex');
      if (sig && sig !== expected) {
        console.warn('[Webhook] Firma inválida');
        return res.status(401).send('Unauthorized');
      }
    } catch (sigErr) {
      console.warn('[Webhook] Error validando firma:', sigErr.message);
    }
  }

  res.status(200).send('OK'); // Responder rápido a MP

  try {
    const { type, data } = req.body;
    const paymentId = data?.id;
    if (type !== 'payment' || !paymentId) return;

    const payment     = new Payment(mpClient);
    const paymentData = await payment.get({ id: paymentId });

    console.log(`[Webhook] Pago ${paymentData.id} | Status: ${paymentData.status}`);

    if (paymentData.status !== 'approved') return;

    const tramiteId = paymentData.external_reference || paymentData.metadata?.tramite_id;
    if (!tramiteId) { console.warn('[Webhook] Sin tramite_id'); return; }

    await supabase
      .from('tramites')
      .update({ estado: 'generando_acta', payment_id: String(paymentData.id) })
      .eq('id', tramiteId);

    console.log(`[Webhook] Tramite ${tramiteId} → generando_acta ✓`);

    // Notificación push al admin
    const { data: t } = await supabase.from('tramites').select('curp').eq('id', tramiteId).single();
    await sendPushNotification('🔔 Nueva solicitud', `CURP: ${t?.curp} — ¡Sube el PDF!`);

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
  }
});

app.get('/api/webhook/mercadopago', async (req, res) => {
  res.status(200).send('OK');
  const { topic, id } = req.query;
  if (topic !== 'payment' || !id) return;
  try {
    const payment     = new Payment(mpClient);
    const paymentData = await payment.get({ id });
    const tramiteId   = paymentData.external_reference;
    if (!tramiteId || paymentData.status !== 'approved') return;
    await supabase.from('tramites')
      .update({ estado: 'generando_acta', payment_id: String(paymentData.id) })
      .eq('id', tramiteId);
  } catch (err) {
    console.error('[Webhook GET]', err.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════
//  ADMIN (protegido con JWT)
// ═════════════════════════════════════════════════════════════════════════

function verifyAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Sin autorización.' });
  try {
    req.admin = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sesión expirada. Inicia sesión de nuevo.' });
  }
}

app.post('/api/admin/login', limiterLogin, (req, res) => {
  const { email, password } = req.body;
  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign({ role: 'admin', email }, process.env.JWT_SECRET, { expiresIn: '8h' });
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
});

app.get('/api/admin/tramites', verifyAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('tramites')
      .select('*')
      .in('estado', ['generando_acta', 'procesando_pago'])
      .order('created_at', { ascending: false });
    if (error) throw error;
    res.json(data || []);
  } catch (err) {
    console.error('[GET admin/tramites]', err.message);
    res.status(500).json({ error: 'Error al cargar trámites.' });
  }
});

app.get('/api/admin/stats', verifyAdmin, async (req, res) => {
  try {
    // Usar COUNT por estado en vez de traer todos los registros
    const estados = ['acta_lista', 'generando_acta', 'procesando_pago', 'pendiente_pago', 'acta_no_encontrada'];
    const counts = await Promise.all(estados.map(estado =>
      supabase.from('tramites').select('id', { count: 'exact', head: true }).eq('estado', estado)
    ));
    res.json({
      actas_completadas: counts[0].count || 0,
      generando:         counts[1].count || 0,
      procesando:        counts[2].count || 0,
      pendiente:         counts[3].count || 0,
      no_encontradas:    counts[4].count || 0,
    });
  } catch (err) {
    console.error('[stats]', err.message);
    res.status(500).json({ error: 'Error al obtener estadísticas.' });
  }
});

app.post('/api/admin/tramites/:id/upload', verifyAdmin, upload.single('pdf'), async (req, res) => {
  try {
    const { id } = req.params;
    if (!req.file) return res.status(400).json({ error: 'No se subió ningún archivo.' });

    const { data: tramite } = await supabase.from('tramites').select('id').eq('id', id).single();
    if (!tramite) return res.status(404).json({ error: 'Trámite no encontrado.' });

    const filePath = `actas/${id}.pdf`;
    const { error: uploadError } = await supabase.storage
      .from('actas').upload(filePath, req.file.buffer, { contentType: 'application/pdf', upsert: true });
    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage.from('actas').getPublicUrl(filePath);
    const { error: updateError } = await supabase.from('tramites')
      .update({ estado: 'acta_lista', acta_url: publicUrl }).eq('id', id);
    if (updateError) throw updateError;

    console.log(`[Upload] Acta subida: ${id}`);
    res.json({ success: true, acta_url: publicUrl });
  } catch (err) {
    console.error('[Upload]', err.message);
    res.status(500).json({ error: 'Error al subir el acta. Intenta de nuevo.' });
  }
});

app.post('/api/admin/tramites/:id/no-encontrada', verifyAdmin, async (req, res) => {
  try {
    const { error } = await supabase.from('tramites')
      .update({ estado: 'acta_no_encontrada' }).eq('id', req.params.id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err) {
    console.error('[no-encontrada]', err.message);
    res.status(500).json({ error: 'Error al actualizar el trámite.' });
  }
});

app.post('/api/admin/cleanup', verifyAdmin, async (req, res) => {
  try {
    // 1. Borrar PDFs huérfanos directamente desde Storage (sin depender de la tabla)
    const { data: archivos, error: listError } = await supabase.storage
      .from('actas')
      .list('actas', { limit: 1000 });

    if (listError) throw listError;

    let eliminados = 0;

    if (archivos && archivos.length > 0) {
      const paths = archivos.map(f => `actas/${f.name}`);
      const { error: removeError } = await supabase.storage
        .from('actas')
        .remove(paths);
      if (!removeError) eliminados = paths.length;
    }

    // 2. Limpiar URLs en la tabla también
    await supabase.from('tramites')
      .update({ acta_url: null })
      .not('acta_url', 'is', null);

    console.log(`[Cleanup Manual] ${eliminados} PDFs eliminados de Storage`);
    res.json({ success: true, eliminados });

  } catch (err) {
    console.error('[Cleanup Manual]', err.message);
    res.status(500).json({ error: 'Error en limpieza.' });
  }
});

app.post('/api/admin/subscribe', verifyAdmin, (req, res) => {
  const subscription = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'Suscripción inválida.' });
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== subscription.endpoint);
  pushSubscriptions.push(subscription);
  res.json({ success: true });
});

app.get('/api/vapid-public-key', (_req, res) => {
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY || null });
});

// ── Cleanup automático (cron-job.org) ────────────────────────────────────
app.get('/api/cleanup-auto', async (req, res) => {
  if (req.headers['x-cleanup-secret'] !== process.env.CLEANUP_SECRET) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  try {
    const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

    // 1. Listar todos los PDFs en Storage y borrarlos
    const { data: archivos } = await supabase.storage
      .from('actas').list('actas', { limit: 1000 });

    let eliminados = 0;
    if (archivos && archivos.length > 0) {
      const paths = archivos.map(f => `actas/${f.name}`);
      const { error } = await supabase.storage.from('actas').remove(paths);
      if (!error) eliminados = paths.length;
    }

    // 2. Borrar registros viejos de la tabla
    const { data: deleted } = await supabase.from('tramites').delete()
      .in('estado', ['acta_lista', 'acta_no_encontrada', 'pendiente_pago'])
      .lt('updated_at', hace24h).select('id');

    // 3. Limpiar URLs huérfanas
    await supabase.from('tramites')
      .update({ acta_url: null })
      .not('acta_url', 'is', null);

    const registrosBorrados = deleted?.length || 0;
    console.log(`[Cleanup Auto] ${eliminados} PDFs + ${registrosBorrados} registros eliminados`);
    res.json({ success: true, eliminados, registrosBorrados, timestamp: new Date().toISOString() });
  } catch (err) {
    console.error('[Cleanup Auto]', err.message);
    res.status(500).json({ error: 'Error en limpieza.' });
  }
});

// ── Fallback SPA ──────────────────────────────────────────────────────────
const indexPath = path.join(__dirname, 'public', 'index.html');
app.get('*', (_req, res) => {
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).json({ status: 'ok' });
  }
});

// ── Manejo global de errores ──────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[Error global]', err.message);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err.message);
});

// ── Arrancar servidor ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
  console.log(`✅ Servidor iniciado en puerto ${PORT}`);
  console.log(`   Supabase:  ${process.env.SUPABASE_URL}`);
  console.log(`   MP Token:  ${process.env.MP_ACCESS_TOKEN ? '✓' : '✗ VACÍO'}`);
  console.log(`   Sandbox:   ${process.env.MP_SANDBOX === 'true' ? 'SÍ' : 'NO'}`);
  console.log(`   Precio:    $${PRECIO_MXN} MXN`);

  try {
    const { error } = await supabase.from('tramites').select('id').limit(1);
    if (error) console.error('⚠️  Supabase ERROR:', error.message);
    else console.log('✅ Supabase conectado');
  } catch (e) {
    console.error('❌ Supabase FETCH FAILED:', e.message);
  }
});

// Timeout de servidor — evita conexiones colgadas a 500 usuarios
server.timeout         = 30000; // 30s máximo por request
server.keepAliveTimeout = 65000; // mayor que el de Render (60s)
server.headersTimeout  = 66000;

// Cierre limpio cuando Render hace deploy (envía SIGTERM)
process.on('SIGTERM', () => {
  console.log('SIGTERM recibido — cerrando servidor...');
  server.close(() => {
    console.log('Servidor cerrado correctamente');
    process.exit(0);
  });
  // Forzar cierre después de 15s si no termina solo
  setTimeout(() => process.exit(0), 15000);
});
