# WhatsApp Pedidos con Agente de IA

Proyecto personal de práctica: un agente de IA que atiende clientes por **WhatsApp Cloud API** (la API oficial de Meta), muestra un catálogo, toma pedidos y avisa al dueño. No es un trabajo de cliente.

## Estado honesto

| Qué | Estado |
|---|---|
| Webhook (verificación GET, firma HMAC `X-Hub-Signature-256`, reintentos idempotentes) | Hecho y probado localmente |
| Lectura de payloads con la forma documentada de la Cloud API (texto, botones, ignora `statuses`) | Hecho y probado con payloads de ejemplo |
| Envío de mensajes (`POST /{phone-number-id}/messages`) | Hecho y **probado con la API real de Meta**: mensaje entregado a un teléfono real |
| Agente con herramientas (catálogo, pedido, pasar a persona) y control de precios | Hecho y probado con un modelo **simulado** |
| **Probado contra WhatsApp real** | **Sí, con número de prueba de Meta** (26-nov-2026, ver abajo) |
| Mensajes entrantes escritos desde un celular real | Pendiente: Meta solo los entrega cuando la app está publicada |
| Probado con un LLM real | No todavía (hay cliente compatible con OpenAI, sin ejecutar) |
| En producción con número de empresa verificado | No |

Es una integración probada con la API real usando el número de prueba de Meta, **no** una integración en producción.

### Prueba con la API real (26-nov-2026)

App de Meta en modo desarrollo, número de prueba `+1 555 153 0068`, webhook expuesto con Cloudflare Tunnel.

| Prueba | Resultado |
|---|---|
| Verificación del webhook (GET con `hub.challenge`) desde el panel de Meta | Aceptada; webhook suscrito al campo `messages` |
| Plantilla `hello_world` enviada a un teléfono real | `accepted` por la API y recibida en el teléfono |
| Webhook de prueba firmado enviado por Meta | Firma HMAC validada y mensaje procesado; la respuesta al número ficticio del ejemplo fue rechazada por Meta (`#131030`, destinatario fuera de la lista), como corresponde |
| Mensajes firmados con el App Secret simulando al cliente | Respondidos con el catálogo por la Cloud API |
| Reenvío del mismo `id` de mensaje (reintento) | Ignorado: no se contestó dos veces |

Hallazgo de la prueba real: el bot registraba la respuesta como enviada aunque Meta la rechazara. Corregido (ahora se registra solo si Meta acepta el envío) y cubierto con una prueba.

## Qué demuestra

- **Seguridad del webhook:** el cuerpo crudo se valida con HMAC-SHA256 en tiempo constante; sin firma válida responde 401 y no procesa nada.
- **Idempotencia:** Meta reenvía webhooks; el `id` del mensaje es clave única, así que nunca se contesta dos veces.
- **Respuesta rápida:** responde 200 de inmediato y procesa en segundo plano (Meta exige respuesta veloz).
- **El modelo no inventa precios:** los precios y totales salen siempre de la base de datos; si la respuesta del modelo menciona un monto que el sistema no leyó/calculó, se bloquea, se pasa a una persona y se avisa al dueño.
- **Pedidos consistentes:** transacción SQL (crear pedido + ítems + descontar stock), validación de cantidades y stock.
- **Traspaso a humano:** al escalar, el bot calla en esa conversación.
- **Sin dependencias:** Node 22 (`node:sqlite`, `node:test`, TypeScript sin compilar).

## Usar

```bash
node --test test/*.test.ts        # 12 pruebas

cp .env.example .env              # completa APP_SECRET, VERIFY_TOKEN, etc.
npm start                         # DRY_RUN=1 por defecto: imprime, no envía
```

## Probar con WhatsApp real (lo hace el dueño de la cuenta)

1. Crear una app en developers.facebook.com con el producto **WhatsApp**. Meta entrega un número de prueba y un token temporal en *API Setup*.
2. Copiar el **App Secret** (*App settings → Basic*) a `APP_SECRET`, el **Phone number ID** a `PHONE_NUMBER_ID` y el token a `WA_TOKEN`.
3. Exponer el puerto con un túnel HTTPS (p. ej. Cloudflare Tunnel) y registrar `https://<túnel>/webhook` con tu `VERIFY_TOKEN`; suscribirse al campo `messages`.
4. Agregar tu número a la lista de destinatarios de prueba, poner `DRY_RUN=0` y escribir al número de prueba.

Nota: Meta no permite la palabra "WhatsApp" en el nombre de la app. Mientras la app no esté publicada, Meta solo entrega webhooks de prueba enviados desde el panel; para recibir mensajes escritos desde un celular hay que publicarla (pide una URL de política de privacidad).

## Estructura

```
src/whatsapp.ts  firma, desafío, lectura de payloads, envío
src/agent.ts     bucle de herramientas + control de precios
src/llm.ts       cliente compatible con OpenAI + modelo simulado
src/db.ts        SQLite: productos, pedidos, conversaciones, mensajes
src/server.ts    webhook HTTP
test/flow.test.ts
```
