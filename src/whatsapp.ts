import { createHmac, timingSafeEqual } from 'node:crypto';

export interface WaConfig {
  dryRun: boolean;
  token: string;
  phoneNumberId: string;
  graphVersion: string;
}

export interface IncomingMessage {
  id: string;
  from: string;
  name?: string;
  text: string;
}

/**
 * Meta firma cada POST con HMAC-SHA256 del cuerpo CRUDO usando el "App Secret".
 * Cabecera: X-Hub-Signature-256: sha256=<hex>. Se compara en tiempo constante.
 */
export function verifySignature(rawBody: Buffer | string, header: string | undefined, appSecret: string): boolean {
  if (!header || !appSecret || !header.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest();
  let received: Buffer;
  try {
    received = Buffer.from(header.slice('sha256='.length), 'hex');
  } catch {
    return false;
  }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/** Verificacion inicial del webhook (GET): Meta envia hub.mode, hub.verify_token y hub.challenge. */
export function verifyChallenge(q: URLSearchParams, verifyToken: string): string | null {
  if (q.get('hub.mode') === 'subscribe' && verifyToken && q.get('hub.verify_token') === verifyToken) {
    return q.get('hub.challenge') ?? '';
  }
  return null;
}

/**
 * Extrae mensajes de texto (y respuestas de botones) del payload de la Cloud API.
 * Ignora "statuses" (entregado/leido) y tipos no soportados (imagen, audio, etc.).
 */
export function parseIncoming(payload: unknown): IncomingMessage[] {
  const out: IncomingMessage[] = [];
  const p = payload as { object?: string; entry?: any[] };
  if (!p || p.object !== 'whatsapp_business_account' || !Array.isArray(p.entry)) return out;
  for (const entry of p.entry) {
    for (const change of entry?.changes ?? []) {
      if (change?.field !== 'messages') continue;
      const value = change.value ?? {};
      const names = new Map<string, string>();
      for (const c of value.contacts ?? []) if (c?.wa_id) names.set(c.wa_id, c.profile?.name);
      for (const m of value.messages ?? []) {
        if (!m?.id || !m?.from) continue;
        let text: string | undefined;
        if (m.type === 'text') text = m.text?.body;
        else if (m.type === 'interactive') text = m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title;
        if (typeof text === 'string' && text.trim()) {
          out.push({ id: m.id, from: m.from, name: names.get(m.from), text: text.trim().slice(0, 1000) });
        }
      }
    }
  }
  return out;
}

export function textPayload(to: string, body: string) {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } };
}

/** Envia un texto con la Cloud API. En DRY_RUN solo lo imprime. */
export async function sendText(cfg: WaConfig, to: string, body: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  if (cfg.dryRun) {
    console.log(`[DRY_RUN] -> ${to}: ${body.replace(/\n/g, ' | ')}`);
    return;
  }
  const url = `https://graph.facebook.com/${cfg.graphVersion}/${cfg.phoneNumberId}/messages`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(textPayload(to, body)),
  });
  if (!res.ok) throw new Error(`WhatsApp Cloud API ${res.status}: ${(await res.text()).slice(0, 300)}`);
}
