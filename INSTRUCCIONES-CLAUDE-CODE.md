# Plan de ejecución — MVP Landings sobre repo hundred-agents

Contexto: repo `macba1/hundred-agents` (rama master), sitio en Vercel proyecto `hundred-agents`,
dominio canónico www.thehagentic.com. NO existe vercel.json hoy. El sitio tiene /api/chat y
/api/lead como serverless auto-detectadas. NO se debe romper nada de eso.

Objetivo de este trabajo:
1. Añadir página de venta en /landings (accesible en thehagentic.com/landings).
2. Añadir landing demo del cliente SanMi en subdominio sanmi.thehagentic.com.
3. Añadir un vercel.json mínimo que SOLO enrute el subdominio sanmi, sin tocar /api ni la home.

REGLA DE ORO: no modificar ningún archivo existente. Solo AÑADIR archivos nuevos + 1 vercel.json.

---

## PASO 1 — Rama de trabajo
```
git checkout master
git pull
git checkout -b feature/landings-mvp
```

## PASO 2 — Copiar los 3 archivos nuevos
Desde el paquete entregado, copiar respetando rutas:
- landings/index.html              → a la raíz del repo: /landings/index.html
- clientes/sanmi/index.html        → /clientes/sanmi/index.html
- vercel.json                      → /vercel.json   (la raíz NO tiene uno hoy; este es nuevo)

No tocar: index.html raíz, styles.css, script.js, conf.js, widget.js, chat.css,
api/*, lib/*, assets/*, conferencia-mexico-2026/*.

## PASO 3 — Verificar vercel.json
El vercel.json debe contener EXACTAMENTE solo el rewrite del host sanmi. Nada de cleanUrls
ni trailingSlash (el sitio funciona sin ellos; añadirlos cambiaría el routing actual).
Confirmar que el contenido es el del paquete.

## PASO 4 — Commit + push de la rama (NO a master)
```
git add landings/ clientes/ vercel.json
git commit -m "feat: landings de venta (/landings) + demo SanMi (subdominio) + vercel.json minimo"
git push -u origin feature/landings-mvp
```
Vercel generará un PREVIEW deploy automático para esta rama.

## PASO 5 — PRUEBA EN PREVIEW (crítico, antes de master)
En la URL de preview que da Vercel, verificar que SIGUEN funcionando:
- [ ] Home (/) carga igual que antes
- [ ] /api/chat responde (probar el widget de chat)
- [ ] /api/lead escribe en Notion (enviar el formulario, confirmar fila nueva)
- [ ] /conferencia-mexico-2026 carga
- [ ] /landings carga la nueva página de venta
Si algo de /api o la home se rompió → NO hacer merge. Reportar a Tony.

NOTA sobre el subdominio en preview: el rewrite de sanmi NO se puede probar del todo en la
URL de preview (el "host" será el hash de Vercel, no sanmi.thehagentic.com). El subdominio
se valida después del PASO 7. En preview basta confirmar que /landings y la home funcionan.

## PASO 6 — Merge a master (solo si PASO 5 pasó limpio)
```
git checkout master
git merge feature/landings-mvp
git push
```

## PASO 7 — Subdominio en Vercel (manual, dashboard)
Vercel → proyecto hundred-agents → Settings → Domains → Add:
  sanmi.thehagentic.com
Como el dominio raíz ya está en este proyecto Vercel, el DNS se resuelve solo.
Confirmar que sanmi.thehagentic.com queda PÚBLICO (no bajo Deployment Protection).
Si Deployment Protection bloquea el subdominio con 401, hay que marcarlo como dominio
de producción público en la config del proyecto.

## PASO 8 — Verificación final en producción
- [ ] https://www.thehagentic.com/landings  → página de venta carga
- [ ] https://sanmi.thehagentic.com           → landing SanMi carga
- [ ] Botón WhatsApp en ambas abre chat al número 16502231870
- [ ] Home, chat y leads siguen intactos

---

## Número de WhatsApp
Actual (prueba): 16502231870. Aparece en /landings/index.html y /clientes/sanmi/index.html.
Cambiar antes de uso real con clientes.

## Para añadir un cliente nuevo después (referencia)
1. Crear /clientes/NUEVO/index.html (copiar de sanmi, cambiar contenido + número).
2. Añadir bloque en vercel.json rewrites con host NUEVO.thehagentic.com → /clientes/NUEVO/index.html
3. Añadir dominio NUEVO.thehagentic.com en Vercel.
4. Commit + push a master.
