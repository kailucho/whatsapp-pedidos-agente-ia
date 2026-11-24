# WhatsApp Pedidos con Agente de IA

Proyecto personal de práctica: un agente de IA que atiende clientes por **WhatsApp Cloud API** (la API oficial de Meta), muestra un catálogo, toma pedidos y avisa al dueño. No es un trabajo de cliente.

## Estado honesto

| Qué | Estado |
|---|---|
| Webhook (verificación GET, firma HMAC `X-Hub-Signature-256`, reintentos idempotentes) | Hecho y probado localmente |
| Lectura de payloads con la forma documentada de la Cloud API (texto, botones, ignora `statuses`) | Hecho y probado con payloads de ejemplo |
| Envío de mensajes (`POST /{phone-number-id}/messages`) | Hecho; probado solo con un `fetch` simulado y en `DRY_RUN` |
| Agente con herramientas (catálogo, pedido, pasar a persona) y control de precios | Hecho y probado con un modelo **simulado** |
| **Probado contra WhatsApp real** | **No todavía.** Requiere una app de Meta con número de prueba (ver abajo) |
| Probado con un LLM real | No todavía (hay cliente compatible con OpenAI, sin ejecutar) |

Hasta que se pruebe con el número de prueba de Meta, esto no se debe presentar como "integración en producción".

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
node --test test/*.test.ts        # 11 pruebas

cp .env.example .env              # completa APP_SECRET, VERIFY_TOKEN, etc.
npm start                         # DRY_RUN=1 por defecto: imprime, no envía
```

## Probar con WhatsApp real (lo hace el dueño de la cuenta)

1. Crear una app en developers.facebook.com con el producto **WhatsApp**. Meta entrega un número de prueba y un token temporal en *API Setup*.
2. Copiar el **App Secret** (*App settings → Basic*) a `APP_SECRET`, el **Phone number ID** a `PHONE_NUMBER_ID` y el token a `WA_TOKEN`.
3. Exponer el puerto con un túnel HTTPS (p. ej. Cloudflare Tunnel) y registrar `https://<túnel>/webhook` con tu `VERIFY_TOKEN`; suscribirse al campo `messages`.
4. Agregar tu número a la lista de destinatarios de prueba, poner `DRY_RUN=0` y escribir al número de prueba.

Verificado el paso 4, se actualiza la tabla de estado de arriba.

## Estructura

```
src/whatsapp.ts  firma, desafío, lectura de payloads, envío
src/agent.ts     bucle de herramientas + control de precios
src/llm.ts       cliente compatible con OpenAI + modelo simulado
src/db.ts        SQLite: productos, pedidos, conversaciones, mensajes
src/server.ts    webhook HTTP
test/flow.test.ts
```
