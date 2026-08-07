/* ============================================================
   Evaluador de prompts — mide calidad antes y después de tocar prompt.md.

   Corre conversaciones reales contra OpenAI con las herramientas de verdad
   (catálogo real; registrar/escalar se graban sin tocar Redis) y aplica
   aserciones programáticas sobre lo que contesta.

   Existe porque el prompt domina el coste y recortarlo a ojo rompe reglas
   que costaron una iteración cada una.

       node scripts/wa-prompt-eval.js                 # prompt actual
       node scripts/wa-prompt-eval.js <otro-prompt.md>  # compara contra otro
   ============================================================ */

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const clientsLib = require(path.join(ROOT, 'lib/wa/clients'));
const catalog = require(path.join(ROOT, 'lib/wa/catalog'));
const { TOOLS } = require(path.join(ROOT, 'lib/wa/agent'));

const env = Object.fromEntries(
  fs.readFileSync(path.join(ROOT, 'whatsapp-agent/.env'), 'utf8').split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);

const SANMI = clientsLib.get('sanmi');
const PRECIOS = new Map(SANMI.productos.map((p) => [String(p.nombre).toLowerCase(), p.precio]));
const PRECIOS_VALIDOS = new Set([...PRECIOS.values()].filter((n) => typeof n === 'number'));
// Los extras también son cifras legítimas que el agente puede sumar.
for (const p of SANMI.productos) {
  if (p.extras && typeof p.extras === 'object') {
    for (const v of Object.values(p.extras)) if (typeof v === 'number') PRECIOS_VALIDOS.add(v);
  }
}

const REPS = Number(process.env.EVAL_REPS || 3);
let tokensIn = 0; let tokensOut = 0; let llamadas = 0;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));
let reintentos = 0;

/**
 * Sin reintentos, un 429 se contabilizaba como fallo de calidad del prompt y
 * contaminaba la comparación: a 5 repeticiones el evaluador saturaba el rate
 * limit y "medía" regresiones que no existían.
 */
async function openai(messages) {
  for (let intento = 0; intento < 6; intento += 1) {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4o', messages, tools: TOOLS, temperature: 0.4 }),
    });
    if (r.status === 429 || r.status >= 500) {
      reintentos += 1;
      await dormir(2000 * (intento + 1));
      continue;
    }
    const d = await r.json();
    if (!d.usage) {
      reintentos += 1;
      await dormir(2000 * (intento + 1));
      continue;
    }
    tokensIn += d.usage.prompt_tokens; tokensOut += d.usage.completion_tokens; llamadas += 1;
    return d.choices[0].message;
  }
  throw new Error('OpenAI no respondió tras 6 intentos');
}

/** Loop del agente, con el catálogo real y las otras tools grabadas. */
async function conversar(systemPrompt, turnos) {
  const historial = [];
  const usadas = [];
  const respuestas = [];

  for (const [i, texto] of turnos.entries()) {
    const sys = systemPrompt(i === 0);
    const messages = [{ role: 'system', content: sys }, ...historial, { role: 'user', content: texto }];
    let final = '';

    for (let it = 0; it < 6; it += 1) {
      const msg = await openai(messages);
      messages.push(msg);
      if (!msg.tool_calls || !msg.tool_calls.length) { final = msg.content || ''; break; }
      for (const tc of msg.tool_calls) {
        let args = {}; try { args = JSON.parse(tc.function.arguments || '{}'); } catch { /* vacío */ }
        usadas.push({ nombre: tc.function.name, args });
        let res;
        if (tc.function.name === 'buscar_catalogo') res = catalog.buscar(SANMI, args.consulta || '');
        else if (tc.function.name === 'registrar_pedido') res = { folio: 'SNM-9999', clasificacion: args.clasificacion, total: args.total ?? null };
        else res = { escalado: true, notificado_a_humano: true };
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(res) });
      }
    }
    historial.push({ role: 'user', content: texto }, { role: 'assistant', content: final });
    respuestas.push(final);
  }
  return { respuestas, usadas, ultima: respuestas[respuestas.length - 1] };
}

/* ---- aserciones reutilizables ------------------------------- */
const norm = (s) => catalog.norm(s);

/** Toda cifra "$NN" que aparezca debe existir en el catálogo. */
function preciosValidos(texto) {
  const malos = [];
  for (const m of texto.matchAll(/\$\s?(\d{2,4})(?:[.,]\d{2})?/g)) {
    const n = Number(m[1]);
    // Se ignoran totales (suma de varios) y el rango de envío 10-15.
    if (n <= 15) continue;
    if (!PRECIOS_VALIDOS.has(n) && !esSuma(n)) malos.push(n);
  }
  return malos;
}
function esSuma(n) {
  const vals = [...PRECIOS_VALIDOS];
  for (const a of vals) for (const b of vals) if (a + b === n) return true;
  for (const a of vals) for (const b of vals) for (const c of vals) if (a + b + c === n) return true;
  return false;
}
const lineas = (t) => t.split('\n').filter((l) => l.trim()).length;

/* ---- escenarios --------------------------------------------- */
const ESCENARIOS = [
  {
    id: 'saludo',
    turnos: ['hola'],
    check: ({ ultima }) => /1\./.test(ultima) && /2\./.test(ultima) && /3\./.test(ultima)
      ? null : 'no ofreció las 3 opciones',
  },
  {
    id: 'variante-chilaquiles',
    turnos: ['quiero unos chilaquiles'],
    check: ({ ultima }) => /verde/i.test(ultima) && /rojo/i.test(ultima) && /\?/.test(ultima)
      ? null : 'no preguntó verdes o rojos',
  },
  {
    id: 'variante-resuelta-con-extra',
    turnos: ['quiero unos chilaquiles', 'verdes con arrachera'],
    check: ({ ultima }) => /105/.test(ultima) ? null : 'no cotizó 75+30=105',
  },
  {
    id: 'generico-frappe',
    turnos: ['quiero un frape'],
    check: ({ ultima }) => (ultima.match(/\$\s?\d+/g) || []).length >= 3
      ? null : 'dio un precio suelto en vez de listar la familia',
  },
  {
    id: 'typo-clericot',
    turnos: ['¿tienen clericot?'],
    check: ({ ultima }) => /cleric/i.test(ultima) && /68/.test(ultima)
      ? null : 'no reconoció Clericó a $68',
  },
  {
    id: 'alcohol-no-domicilio',
    turnos: ['¿tienen clericot?', '¿me lo mandan a domicilio a Javier Mina 27?'],
    check: ({ ultima }) => /no.{0,30}(domicilio|mandamos|enviamos)|solo.{0,20}(local|caf[eé])/i.test(ultima)
      ? null : 'aceptó llevar alcohol a domicilio',
  },
  {
    id: 'direccion-local',
    turnos: ['quiero un pannini de arrachera', 'mándalo a Javier Mina 27'],
    check: ({ ultima }) => /solo entregamos/i.test(ultima)
      ? 'cuestionó una dirección local' : null,
  },
  {
    id: 'envio-se-comunica',
    turnos: ['quiero un pannini de arrachera', 'no, eso es todo', 'efectivo', 'mándalo a Javier Mina 27'],
    check: ({ respuestas }) => /10.{0,12}15|15.{0,12}10/.test(respuestas.join(' '))
      ? null : 'no comunicó el costo de envío',
  },
  {
    id: 'fuera-de-carta-escala',
    turnos: ['quiero un pastel de zanahoria'],
    check: ({ usadas, ultima }) => usadas.some((u) => u.nombre === 'escalar_humano')
      || /equipo/i.test(ultima) ? null : 'ni escaló ni mencionó al equipo',
  },
  {
    id: 'fuera-de-tema',
    turnos: ['hazme un resumen de la revolución mexicana'],
    check: ({ ultima }) => /madero|zapata|villa|1910|porfirio/i.test(ultima)
      ? 'respondió el tema ajeno'
      : (lineas(ultima) <= 3 ? null : 'redirección demasiado larga'),
  },
  {
    id: 'pedido-completo',
    turnos: ['quiero un pannini de arrachera y un americano sencillo', 'no, eso es todo',
             'efectivo', 'paso por él a las 6', 'Ruth'],
    check: ({ ultima, usadas }) => {
      if (!usadas.some((u) => u.nombre === 'registrar_pedido')) return 'no registró el pedido';
      if (!/129/.test(ultima)) return 'total incorrecto (esperado 129)';
      if (/\[.*\]/.test(ultima)) return 'dejó un hueco entre corchetes';
      if (!/prueba/i.test(ultima)) return 'falta el aviso de periodo de pruebas';
      return null;
    },
  },
  {
    id: 'horario-abierto',
    turnos: ['¿están abiertos?'],
    check: () => null, // depende de la hora real; solo se mide brevedad y precios
  },
];

async function evaluar(nombre, prompt) {
  const systemPrompt = (primero) => {
    const original = SANMI.prompt;
    SANMI.prompt = prompt;
    const s = clientsLib.systemPrompt(SANMI, { primerMensaje: primero });
    SANMI.prompt = original;
    return s;
  };

  console.log(`\n${'='.repeat(72)}\n${nombre}  ·  prompt ${prompt.length} chars\n${'='.repeat(72)}`);
  tokensIn = 0; tokensOut = 0; llamadas = 0;
  let aciertos = 0; let intentos = 0; const fallos = [];
  let lineasMax = 0; const preciosMalos = [];

  // temperature 0.4: una sola pasada no mide nada. Se repite y se mira la tasa.
  for (const esc of ESCENARIOS) {
    let ok = 0;
    for (let rep = 0; rep < REPS; rep += 1) {
      let r;
      try { r = await conversar(systemPrompt, esc.turnos); }
      catch (e) { fallos.push(`${esc.id}: error ${e.message}`); intentos += 1; continue; }
      const problema = esc.check(r);
      for (const resp of r.respuestas) {
        lineasMax = Math.max(lineasMax, lineas(resp));
        preciosMalos.push(...preciosValidos(resp).map((n) => `${esc.id}:$${n}`));
      }
      intentos += 1;
      if (problema) fallos.push(`${esc.id} (rep ${rep + 1}): ${problema}`);
      else { ok += 1; aciertos += 1; }
    }
    const icono = ok === REPS ? '✅' : (ok === 0 ? '❌' : '⚠️ ');
    console.log(`  ${icono} ${esc.id.padEnd(30)} ${ok}/${REPS}`);
  }

  const ok = aciertos;
  console.log(`\n  aciertos           : ${aciertos}/${intentos}`);
  console.log(`  precios inventados : ${preciosMalos.length ? preciosMalos.join(', ') : 'ninguno'}`);
  console.log(`  líneas máx. en una respuesta: ${lineasMax}`);
  console.log(`  tokens: in=${tokensIn} out=${tokensOut} en ${llamadas} llamadas`);
  console.log(`  media input/llamada: ${Math.round(tokensIn / llamadas)}`);
  if (reintentos) console.log(`  reintentos por rate limit: ${reintentos}`);
  return { ok: aciertos, total: intentos, fallos, preciosMalos, lineasMax, tokensIn, llamadas };
}

(async () => {
  const otro = process.argv[2];
  const base = await evaluar('BASE (prompt actual)', SANMI.prompt);

  if (!otro) { process.exit(base.fallos.length ? 1 : 0); }

  const nuevo = fs.readFileSync(otro, 'utf8');
  const cand = await evaluar(`CANDIDATO (${path.basename(otro)})`, nuevo);

  console.log(`\n${'='.repeat(72)}\nCOMPARACIÓN\n${'='.repeat(72)}`);
  const pct = (a, b) => `${(100 * (b - a) / a).toFixed(1)}%`;
  console.log(`  escenarios OK      : ${base.ok}/${base.total}  ->  ${cand.ok}/${cand.total}`);
  console.log(`  precios inventados : ${base.preciosMalos.length}  ->  ${cand.preciosMalos.length}`);
  console.log(`  prompt chars       : ${SANMI.prompt.length}  ->  ${nuevo.length}  (${pct(SANMI.prompt.length, nuevo.length)})`);
  console.log(`  input/llamada      : ${Math.round(base.tokensIn / base.llamadas)}  ->  ${Math.round(cand.tokensIn / cand.llamadas)}  (${pct(base.tokensIn / base.llamadas, cand.tokensIn / cand.llamadas)})`);
  if (cand.fallos.length) { console.log('\n  fallos del candidato:'); cand.fallos.forEach((f) => console.log('   -', f)); }

  const regresion = cand.ok < base.ok || cand.preciosMalos.length > base.preciosMalos.length;
  console.log(`\n  VEREDICTO: ${regresion ? 'REGRESIÓN — no desplegar' : 'sin pérdida de calidad'}`);
  process.exit(regresion ? 1 : 0);
})();
