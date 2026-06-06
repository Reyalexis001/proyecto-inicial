/**
 * Sistema de Actas Mexicanas — Backend
 * Express + Supabase + MercadoPago
 */

require('dotenv').config();
const express  = require('express');
const cors     = require('cors');
const multer   = require('multer');
const path     = require('path');
const jwt      = require('jsonwebtoken');
const { createClient }                  = require('@supabase/supabase-js');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app = express();

// ── Storage en memoria para uploads (se sube directo a Supabase) ──────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 }, // 15 MB máx
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Solo se permiten archivos PDF'));
  }
});

// ── Clientes externos ─────────────────────────────────────────────────────
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE
);

const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 8000 }
});

// ── Middleware global ─────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Servir el frontend estático desde /public
app.use(express.static(path.join(__dirname, 'public')));

// ── Health check (Render lo usa para verificar el servicio) ───────────────
app.get('/health', (_req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

// ═════════════════════════════════════════════════════════════════════════
//  RUTAS PÚBLICAS — Trámites
// ═════════════════════════════════════════════════════════════════════════

/**
 * POST /api/tramite
 * El usuario envía su CURP → se crea el trámite y se devuelve la URL de pago.
 */
app.post('/api/tramite', async (req, res) => {
  try {
    const { curp } = req.body;

    // Validación básica de CURP (18 caracteres, formato RMAT)
    const curpRegex = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z\d]\d$/i;
    if (!curp || !curpRegex.test(curp.trim())) {
      return res.status(400).json({ error: 'CURP inválido. Verifica que sean 18 caracteres con el formato correcto.' });
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
      return res.json({
        tramite_id: existing.id,
        redirect_url: null,
        existing: true,
        message: 'Ya tienes un trámite activo para este CURP. Puedes consultar su estado.'
      });
    }

    // Crear registro en la base de datos
    const { data: tramite, error: insertError } = await supabase
      .from('tramites')
      .insert({ curp: curpUpper, estado: 'pendiente_pago' })
      .select()
      .single();

    if (insertError) throw insertError;

    // Crear preferencia — misma estructura del proyecto anterior que funcionaba
    const preference = new Preference(mpClient);
    const mpPref = await preference.create({
      body: {
        items: [{
          title:       'Acta de Nacimiento Digital',
          quantity:    1,
          unit_price:  5,
          currency_id: 'MXN'
        }],
        metadata: {
          tramite_id: tramite.id,
          curp:       curpUpper
        },
        external_reference: tramite.id,
        back_urls: {
          success: `${process.env.FRONTEND_URL}/seguimiento.html?id=${tramite.id}`,
          failure: `${process.env.FRONTEND_URL}/seguimiento.html?id=${tramite.id}`
        },
        auto_return: 'approved',
        notification_url: `${process.env.BACKEND_URL}/api/webhook/mercadopago`
      }
    });
    // Log completo de la respuesta de MP para debug
    console.log('[MP] Preferencia completa:', JSON.stringify({
      id:                  mpPref.id,
      init_point:          mpPref.init_point,
      sandbox_init_point:  mpPref.sandbox_init_point,
      collector_id:        mpPref.collector_id,
      client_id:           mpPref.client_id,
    }, null, 2));

    // Guardar el preference_id en el trámite
    await supabase
      .from('tramites')
      .update({ preference_id: mpPref.id })
      .eq('id', tramite.id);

    // Siempre usar init_point de producción (MP_SANDBOX=false)
    // Nunca mezclar sandbox_init_point con credenciales de producción
    const checkoutUrl = mpPref.init_point;
    console.log('[MP] Usando init_point producción:', checkoutUrl);

    res.json({
      tramite_id:  tramite.id,
      redirect_url: checkoutUrl,
      existing:    false
    });

  } catch (err) {
    console.error('[POST /api/tramite] FULL ERROR:', err);
    res.status(500).json({ error: 'Error al crear el trámite. Intenta de nuevo.' });
  }
});

/**
 * GET /api/tramite/curp/:curp
 * Consultar el estado de un trámite por CURP (desde la página de inicio).
 */
app.get('/api/tramite/curp/:curp', async (req, res) => {
  try {
    const curp = req.params.curp.toUpperCase().trim();

    const { data: tramites, error } = await supabase
      .from('tramites')
      .select('id, curp, estado, created_at, acta_url')
      .eq('curp', curp)
      .order('created_at', { ascending: false });

    if (error) throw error;

    if (!tramites || tramites.length === 0) {
      return res.json({ found: false, tramites: [] });
    }

    res.json({ found: true, tramites });

  } catch (err) {
    console.error('[GET tramite/curp] FULL ERROR:', err);
    res.status(500).json({ error: 'Error al consultar trámites.' });
  }
});

/**
 * GET /api/tramite/id/:id
 * Consultar el estado de un trámite por su ID (desde la página de seguimiento).
 */
app.get('/api/tramite/id/:id', async (req, res) => {
  try {
    const { data: tramite, error } = await supabase
      .from('tramites')
      .select('id, curp, estado, created_at, acta_url')
      .eq('id', req.params.id)
      .single();

    if (error || !tramite) {
      return res.status(404).json({ error: 'Trámite no encontrado.' });
    }

    res.json(tramite);

  } catch (err) {
    console.error('[GET tramite/id] FULL ERROR:', err);
    res.status(500).json({ error: 'Error al consultar trámite.' });
  }
});

// ═════════════════════════════════════════════════════════════════════════
//  WEBHOOK — MercadoPago
// ═════════════════════════════════════════════════════════════════════════

/**
 * POST /api/webhook/mercadopago
 * MercadoPago llama aquí cuando cambia el estado de un pago.
 * IMPORTANTE: responder 200 inmediatamente, procesar después.
 */
app.post('/api/webhook/mercadopago', async (req, res) => {
  res.status(200).send('OK'); // MP requiere respuesta rápida

  try {
    const { type, data } = req.body;
    const paymentId = data?.id;

    if (type !== 'payment' || !paymentId) return;

    const payment     = new Payment(mpClient);
    const paymentData = await payment.get({ id: paymentId });

    console.log('[Webhook] Pago recibido:', paymentData.id, '| Status:', paymentData.status);

    // Solo procesar pagos aprobados (igual que proyecto anterior)
    if (paymentData.status !== 'approved') return;

    // Buscar tramite por external_reference o por metadata.tramite_id
    const tramiteId = paymentData.external_reference
      || paymentData.metadata?.tramite_id;

    if (!tramiteId) {
      console.log('[Webhook] Sin tramite_id en el pago');
      return;
    }

    await supabase
      .from('tramites')
      .update({ estado: 'generando_acta', payment_id: String(paymentData.id) })
      .eq('id', tramiteId);

    console.log('[Webhook] Tramite', tramiteId, '→ generando_acta ✓');

  } catch (err) {
    console.error('[Webhook] Error:', err.message);
  }
});

/**
 * GET /api/webhook/mercadopago
 * Algunas versiones de MP usan GET con ?topic=payment&id=...
 */
app.get('/api/webhook/mercadopago', async (req, res) => {
  res.status(200).send('OK');

  const { topic, id } = req.query;
  if (topic !== 'payment' || !id) return;

  try {
    const payment     = new Payment(mpClient);
    const paymentData = await payment.get({ id });
    const tramiteId   = paymentData.external_reference;
    if (!tramiteId) return;

    let newEstado = 'pendiente_pago';
    if (paymentData.status === 'approved') newEstado = 'generando_acta';
    else if (['pending', 'in_process', 'authorized'].includes(paymentData.status)) newEstado = 'procesando_pago';

    await supabase
      .from('tramites')
      .update({ estado: newEstado, payment_id: String(paymentData.id) })
      .eq('id', tramiteId);

  } catch (err) {
    console.error('[Webhook GET] Error:', err.message);
  }
});

// ═════════════════════════════════════════════════════════════════════════
//  RUTAS ADMIN (protegidas con JWT)
// ═════════════════════════════════════════════════════════════════════════

/** Middleware de autenticación admin */
function verifyAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Sin autorización.' });
  }
  try {
    req.admin = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Sesión expirada. Inicia sesión de nuevo.' });
  }
}

/**
 * POST /api/admin/login
 * Autenticación del administrador. Devuelve JWT válido por 8 horas.
 */
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;

  if (email === process.env.ADMIN_EMAIL && password === process.env.ADMIN_PASSWORD) {
    const token = jwt.sign(
      { role: 'admin', email },
      process.env.JWT_SECRET,
      { expiresIn: '8h' }
    );
    res.json({ token });
  } else {
    // Mismo mensaje para no revelar qué campo es incorrecto
    res.status(401).json({ error: 'Correo o contraseña incorrectos.' });
  }
});

/**
 * GET /api/admin/tramites
 * Lista de trámites pendientes (generando_acta y procesando_pago).
 */
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
    console.error('[GET admin/tramites] FULL ERROR:', err);
    res.status(500).json({ error: 'Error al cargar trámites.' });
  }
});

/**
 * POST /api/admin/tramites/:id/upload
 * El admin sube el PDF del acta. Se guarda en Supabase Storage.
 */
app.post('/api/admin/tramites/:id/upload', verifyAdmin, upload.single('pdf'), async (req, res) => {
  try {
    const { id } = req.params;

    if (!req.file) {
      return res.status(400).json({ error: 'No se subió ningún archivo.' });
    }

    // Verificar que el trámite existe
    const { data: tramite } = await supabase
      .from('tramites')
      .select('id, estado')
      .eq('id', id)
      .single();

    if (!tramite) {
      return res.status(404).json({ error: 'Trámite no encontrado.' });
    }

    // Subir PDF a Supabase Storage (bucket: "actas")
    const filePath = `actas/${id}.pdf`;

    const { error: uploadError } = await supabase.storage
      .from('actas')
      .upload(filePath, req.file.buffer, {
        contentType: 'application/pdf',
        upsert: true      // Sobreescribir si ya existe
      });

    if (uploadError) throw uploadError;

    // Obtener URL pública del archivo
    const { data: { publicUrl } } = supabase.storage
      .from('actas')
      .getPublicUrl(filePath);

    // Actualizar estado del trámite
    const { error: updateError } = await supabase
      .from('tramites')
      .update({ estado: 'acta_lista', acta_url: publicUrl })
      .eq('id', id);

    if (updateError) throw updateError;

    console.log(`[Upload] Acta subida para trámite ${id}`);
    res.json({ success: true, acta_url: publicUrl });

  } catch (err) {
    console.error('[POST /api/admin/upload]', err.message);
    res.status(500).json({ error: 'Error al subir el acta. Intenta de nuevo.' });
  }
});


/**
 * POST /api/admin/tramites/:id/no-encontrada
 */
app.post('/api/admin/tramites/:id/no-encontrada', verifyAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { error } = await supabase.from('tramites').update({ estado: 'acta_no_encontrada' }).eq('id', id);
    if (error) throw error;
    console.log(`[Admin] Tramite ${id} -> acta_no_encontrada`);
    res.json({ success: true });
  } catch (err) {
    console.error('[no-encontrada]', err.message);
    res.status(500).json({ error: 'Error al actualizar el tramite.' });
  }
});

/**
 * POST /api/admin/cleanup — Elimina PDFs con mas de 24h
 */
app.post('/api/admin/cleanup', verifyAdmin, async (req, res) => {
  try {
    const hace24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: viejos } = await supabase.from('tramites').select('id').eq('estado','acta_lista').lt('updated_at', hace24h).not('acta_url','is',null);
    let eliminados = 0;
    for (const t of viejos || []) {
      const { error } = await supabase.storage.from('actas').remove([`actas/${t.id}.pdf`]);
      if (!error) { await supabase.from('tramites').update({ acta_url: null }).eq('id', t.id); eliminados++; }
    }
    res.json({ success: true, eliminados });
  } catch (err) {
    res.status(500).json({ error: 'Error en limpieza.' });
  }
});

// ─── Fallback SPA ────────────────────────────────────────────────────────
app.get('*', (_req, res) => {
  const fs = require('fs');
  const indexPath = path.join(__dirname, 'public', 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).json({ status: 'ok', message: 'API corriendo.' });
  }
});

// ── Arrancar servidor ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`✅ Servidor iniciado en puerto ${PORT}`);
  console.log(`   Supabase URL:  ${process.env.SUPABASE_URL}`);
  console.log(`   Service Role:  ${process.env.SUPABASE_SERVICE_ROLE ? '✓ definido (' + process.env.SUPABASE_SERVICE_ROLE.slice(0,20) + '...)' : '✗ VACÍO'}`);
  console.log(`   MP Token:      ${process.env.MP_ACCESS_TOKEN      ? '✓ definido' : '✗ VACÍO'}`);
  console.log(`   Modo sandbox:  ${process.env.MP_SANDBOX === 'true' ? 'SÍ' : 'NO'}`);

  // Prueba de conectividad con Supabase al arrancar
  try {
    const { error } = await supabase.from('tramites').select('id').limit(1);
    if (error) {
      console.error('⚠️  Supabase ERROR:', error.message, error.code);
    } else {
      console.log('✅ Supabase conectado correctamente');
    }
  } catch (e) {
    console.error('❌ Supabase FETCH FAILED:', e.message);
    console.error('   Verifica SUPABASE_URL y SUPABASE_SERVICE_ROLE en Render.');
  }
});
