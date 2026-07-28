# Sanmi Café — cliente del agente de WhatsApp

Cafetería en **San Miguel el Alto, Jalisco**. Hoy corre en **modo demo** sobre el
número de pruebas de Meta que antes usaba `demo-dulces`.

| | |
|---|---|
| Clave | `sanmi` |
| Estado | activo (`activo: true` en `config.json`) |
| `phone_number_id` | `1211779025353605` — **número DEMO de Meta**, prestado |
| Número que ve el cliente | `+1 555-150-6096` (`Test Number` de Meta) |
| Folios | `SNM-0001`, `SNM-0002`, … |
| Panel | `/leads?client=sanmi` |
| Límites | 60 turnos por contacto · 30 mensajes de memoria · 5 audios/día |

`demo-dulces` quedó **inactivo** (`activo: false`) con su carpeta intacta: comparte
el mismo `phone_number_id`, y el arranque falla a propósito si los dos están
activos a la vez.

---

## Archivos

| Archivo | Qué contiene | Cuándo se toca |
|---|---|---|
| `config.json` | `phone_number_id`, nombre, límites, `human_notify_wa`, **datos del negocio** (horario, dirección, teléfono…) | Al migrar al número real y al recibir los datos reales |
| `prompt.md` | Personalidad y reglas del asistente | Si cambia el tono o el alcance |
| `catalogo.json` | Menú. **Todos los precios dicen `REEMPLAZAR`** | En cuanto llegue la carta real |

Los tres se recargan **al reiniciar el proceso**. No hay recarga en caliente.

---

## Pendientes antes de salir de modo demo

1. **Menú real** → `catalogo.json`: sustituir cada `"precio": "REEMPLAZAR"` por el
   precio en MXN. La estructura ya está lista; no hay que tocar código.
2. **Datos del negocio** → `config.json` → `datos`: los campos marcados
   `PENDIENTE (REEMPLAZAR)` (dirección, horario, teléfono, pagos, tiempo de
   recolección, domicilio). Mientras digan `PENDIENTE`, el agente los da como
   provisionales y aclara que están por confirmar.
3. **Número real de Sanmi** → ver migración abajo.
4. **Notificación de escalamiento** → ver la nota de `human_notify_wa`.

---

## Migración al número real de Sanmi

> **El único campo que cambia en el código es `phone_number_id` en
> `clients/sanmi/config.json`.** Nada más. El enrutado del webhook es por ese
> valor, así que en cuanto apunte al número real, Sanmi contesta desde su propio
> WhatsApp.

### En el panel de Meta (una sola vez)

1. Meta for Developers → la app → **WhatsApp → API Setup**.
2. **Add phone number**: dar de alta el número real de Sanmi Café en el WhatsApp
   Business Account y completar la verificación por SMS/llamada.
3. Registrar el **nombre para mostrar** (*display name*) del negocio y esperar la
   aprobación de Meta.
4. Copiar el **Phone number ID** del número nuevo (es el número largo que aparece
   junto al teléfono; **no** es el teléfono ni el WABA ID).
5. Cambiar el **access token temporal por uno permanente**: crear un *System User*
   con permisos `whatsapp_business_messaging` + `whatsapp_business_management` y
   generar un token que no caduque. El token de 24 h solo sirve para la demo.
6. **Configuration → Webhook**: confirmar que la URL y el *verify token* son los
   mismos (`WHATSAPP_VERIFY_TOKEN`) y que el campo **`messages`** está suscrito.
   El webhook es uno solo para toda la app: sirve para todos los números.

### En el repo

7. Editar `clients/sanmi/config.json`:

   ```jsonc
   {
     "phone_number_id": "<PHONE_NUMBER_ID_REAL_DE_SANMI>",  // <- ÚNICO cambio obligatorio
     "modo": "produccion"                                   // <- quita los avisos de "periodo de pruebas"
   }
   ```

8. Si `modo` pasa a `produccion`, quitar de `prompt.md` la sección
   **`## MODO DEMO — importante`**: ahí es donde el agente avisa que no se pueden
   procesar pedidos ni pagos reales.
9. Subir el token permanente a `.env` (`WHATSAPP_TOKEN`).
10. Reiniciar el servicio y validar:

    ```bash
    python check_config.py     # debe listar sanmi ACTIVO con el número real y calidad GREEN
    python smoke_test.py       # regresión offline
    curl localhost:8000/health # "clientes": sanmi con el phone_number_id nuevo
    ```

11. Mandar un mensaje real desde otro teléfono y confirmar que aparece en
    `/leads?client=sanmi`.

### Reactivar `demo-dulces` (opcional)

Una vez que Sanmi tenga número propio, el número demo queda libre:

```jsonc
// clients/demo-dulces/config.json
{ "activo": true }
```

Ya no hay conflicto, porque `sanmi` apunta a otro `phone_number_id`.

### Qué NO hay que tocar

- El código (`main.py`) — el enrutado ya es por `phone_number_id`.
- `WHATSAPP_VERIFY_TOKEN` ni la URL del webhook.
- La base de datos: el historial de la demo queda bajo `client='sanmi'` y sigue
  ahí. Si se quiere empezar limpio en producción:

  ```sql
  DELETE FROM leads WHERE client='sanmi';
  DELETE FROM messages WHERE client='sanmi';
  DELETE FROM sessions WHERE client='sanmi';
  ```

---

## `human_notify_wa` — pendiente de habilitar

`config.json` trae `human_notify_wa: "523471053350"`. **Todavía no entrega.**
Probado el 2026-07-28 contra Graph v20.0 con los dos formatos:

| Destino | Resultado |
|---|---|
| `523471053350` | HTTP 400 · `(#131030) Recipient phone number not in allowed list` |
| `5213471053350` | HTTP 400 · `(#131030) Recipient phone number not in allowed list` |

Los dos fallan **igual**, así que no es problema de formato: es la restricción de
los números de prueba de Meta, que solo pueden escribir a destinatarios dados de
alta a mano.

**Para habilitarlo:** Meta for Developers → app → **WhatsApp → API Setup** →
sección **To** → *Manage phone number list* → agregar `+52 347 105 3350` y
confirmar el código que llega por WhatsApp. Después, el escalamiento entrega solo.

Con el número real de Sanmi (paso de migración) esta restricción desaparece: los
números productivos escriben a cualquier destinatario.

Si al habilitarlo Meta sigue rechazando, cambiar `human_notify_wa` por el valor de
`human_notify_wa_alt` (`5213471053350`) — México a veces necesita el `1` después
del `52` para móviles.

---

## Probar

```bash
python check_config.py                    # configuración y enrutado
python smoke_test.py                      # regresión offline, sin llaves
python test_sanmi_real.py                 # OpenAI real, nada sale a Meta
python test_sanmi_real.py --notify-real    # además intenta el aviso real de escalamiento
python make_audio_fixture.py              # regenera fixtures/*.ogg con TTS
```
