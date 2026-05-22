-- ============================================================
-- Sistema de Actas Mexicanas — Esquema de Base de Datos
-- Ejecutar en: Supabase Dashboard > SQL Editor > New Query
-- ============================================================

-- Habilitar extensión UUID
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ─── Tabla principal: tramites ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tramites (
  id              UUID        DEFAULT uuid_generate_v4() PRIMARY KEY,
  curp            TEXT        NOT NULL,
  estado          TEXT        NOT NULL DEFAULT 'pendiente_pago',
  -- Estados posibles:
  --   pendiente_pago  → esperando que el usuario pague
  --   procesando_pago → pago en revisión por MercadoPago
  --   generando_acta  → pago aprobado, admin debe subir el acta
  --   acta_lista      → acta disponible para descarga
  payment_id      TEXT,         -- ID del pago en MercadoPago
  preference_id   TEXT,         -- ID de la preferencia de MercadoPago
  acta_url        TEXT,         -- URL pública del PDF en Supabase Storage
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

-- Índices para consultas frecuentes
CREATE INDEX IF NOT EXISTS idx_tramites_curp    ON tramites(curp);
CREATE INDEX IF NOT EXISTS idx_tramites_estado  ON tramites(estado);
CREATE INDEX IF NOT EXISTS idx_tramites_created ON tramites(created_at DESC);

-- ─── Trigger: updated_at automático ─────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS tramites_updated_at ON tramites;

CREATE TRIGGER tramites_updated_at
  BEFORE UPDATE ON tramites
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- ─── Row Level Security ──────────────────────────────────────────────────
-- El backend usa service_role (acceso total). Usuarios públicos: sin acceso directo.
ALTER TABLE tramites ENABLE ROW LEVEL SECURITY;

-- Política: service_role tiene acceso completo
CREATE POLICY "Backend service_role full access" ON tramites
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- ============================================================
-- DESPUÉS DE EJECUTAR ESTE SQL:
-- 1. Ve a Supabase > Storage > New Bucket
-- 2. Nombre: actas
-- 3. Activa "Public bucket" ✓ (para que los usuarios puedan descargar)
-- 4. Guarda
-- ============================================================
