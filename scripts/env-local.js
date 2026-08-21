/* ============================================================
   Carga variables desde un .env local SOLO para desarrollo.

       node -r ./scripts/env-local.js scripts/demo-server.js
       node -r ./scripts/env-local.js scripts/providencia-acceptance.js

   Busca, por orden, el primer archivo que exista: .env.local, .env,
   whatsapp-agent/.env. Nunca sobreescribe una variable que ya venga del
   entorno, y no imprime ningún valor.

   En Vercel no interviene: allí las variables las pone la plataforma.
   ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const CANDIDATOS = ['.env.local', '.env', path.join('whatsapp-agent', '.env')];

for (const rel of CANDIDATOS) {
  const f = path.join(ROOT, rel);
  if (!fs.existsSync(f)) continue;
  let cargadas = 0;
  for (const linea of fs.readFileSync(f, 'utf8').split('\n')) {
    const t = linea.trim();
    if (!t || t.startsWith('#')) continue;
    const i = t.indexOf('=');
    if (i < 1) continue;
    const clave = t.slice(0, i).trim();
    const valor = t.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    if (!valor || process.env[clave] != null) continue;
    process.env[clave] = valor;
    cargadas += 1;
  }
  console.log(`[env-local] ${cargadas} variable(s) desde ${rel}`);
  break;
}
