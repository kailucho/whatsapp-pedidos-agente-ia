import { type Db, isHandedOff, money, recentMessages, setHandoff } from './db.ts';
import type { ChatMessage, Llm, ToolDef } from './llm.ts';

export interface AgentDeps {
  db: Db;
  llm: Llm;
  notifyOwner: (text: string) => Promise<void>;
}

const SYSTEM = `Eres el asistente de una tienda por WhatsApp. Responde breve, amable y en español.
REGLAS: usa SIEMPRE las herramientas para precios y pedidos. Nunca inventes precios ni productos.
Si el cliente pide hablar con una persona, tiene un reclamo o no puedes resolver algo, usa escalate_to_human.
Antes de crear un pedido confirma producto y cantidad con el cliente.`;

export const TOOLS: ToolDef[] = [
  { name: 'list_catalog', description: 'Lista productos disponibles con precio y stock.', parameters: { type: 'object', properties: {} } },
  {
    name: 'create_order',
    description: 'Crea un pedido. El total lo calcula el sistema.',
    parameters: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object', properties: { sku: { type: 'string' }, qty: { type: 'integer' } }, required: ['sku', 'qty'] } } },
      required: ['items'],
    },
  },
  {
    name: 'escalate_to_human',
    description: 'Pasa la conversacion a una persona y avisa al dueño.',
    parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: ['reason'] },
  },
];

const FALLBACK = 'No tengo ese dato confirmado. Te paso con una persona del equipo para ayudarte.';

/** Convierte "12.50" o "12,5" a centavos. */
const toCents = (s: string): number => Math.round(parseFloat(s.replace(',', '.')) * 100);

export async function handleMessage(deps: AgentDeps, waId: string, text: string): Promise<string | null> {
  const { db, llm } = deps;
  if (isHandedOff(db, waId)) return null; // una persona atiende: el bot calla

  const history: ChatMessage[] = recentMessages(db, waId).map((m) => ({
    role: m.direction === 'in' ? 'user' : 'assistant',
    content: m.body,
  }));
  const messages: ChatMessage[] = [{ role: 'system', content: SYSTEM }, ...history];
  // el mensaje nuevo ya esta guardado en historial si se registro antes; evitamos duplicarlo
  if (!(messages.at(-1)?.role === 'user' && messages.at(-1)?.content === text)) messages.push({ role: 'user', content: text });

  const allowedCents = new Set<number>(); // precios y totales que el sistema SI conoce en este turno
  let escalated = false;

  for (let step = 0; step < 4; step++) {
    const res = await llm.chat(messages, TOOLS);
    if (res.tool_calls?.length) {
      messages.push({ role: 'assistant', content: res.content ?? null, tool_calls: res.tool_calls });
      for (const tc of res.tool_calls) {
        const out = runTool(deps, waId, tc.name, tc.arguments, allowedCents);
        if (tc.name === 'escalate_to_human') escalated = true;
        messages.push({ role: 'tool', tool_call_id: tc.id, content: JSON.stringify(out) });
      }
      if (escalated) {
        await deps.notifyOwner(`Cliente ${waId} necesita atencion humana: ${text.slice(0, 160)}`);
      }
      continue;
    }
    return finish(deps, waId, text, guard(deps, waId, res.content ?? '', allowedCents), escalated);
  }
  return finish(deps, waId, text, FALLBACK, escalated);
}

/** Si se respondio con el mensaje de seguridad sin haber avisado antes, avisa al dueño. */
async function finish(deps: AgentDeps, waId: string, text: string, reply: string, escalated: boolean): Promise<string> {
  if (reply === FALLBACK) {
    setHandoff(deps.db, waId);
    if (!escalated) await deps.notifyOwner(`Respuesta bloqueada por seguridad para ${waId}: ${text.slice(0, 160)}`);
  }
  return reply;
}

/** Si la respuesta menciona un monto que el sistema no calculo/leyo de la base, NO se envia. */
function guard(_deps: AgentDeps, _waId: string, reply: string, allowed: Set<number>): string {
  const amounts = [...reply.matchAll(/S\/\s?(\d+(?:[.,]\d{1,2})?)/g)].map((m) => toCents(m[1]));
  return amounts.some((c) => !allowed.has(c)) ? FALLBACK : reply;
}

function runTool(deps: AgentDeps, waId: string, name: string, rawArgs: string, allowed: Set<number>): unknown {
  const { db } = deps;
  let args: any = {};
  try {
    args = JSON.parse(rawArgs || '{}');
  } catch {
    return { error: 'argumentos invalidos' };
  }

  if (name === 'list_catalog') {
    const rows = db.prepare('SELECT sku, name, price_cents, stock FROM products WHERE stock > 0 ORDER BY name').all() as any[];
    rows.forEach((r) => allowed.add(r.price_cents));
    return { products: rows.map((r) => ({ sku: r.sku, name: r.name, price: money(r.price_cents), stock: r.stock })) };
  }

  if (name === 'escalate_to_human') {
    setHandoff(db, waId);
    return { ok: true };
  }

  if (name === 'create_order') {
    const items = args.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 10) return { error: 'items invalidos' };
    try {
      db.exec('BEGIN');
      let total = 0;
      const lines: { sku: string; name: string; qty: number; unit: number }[] = [];
      for (const it of items) {
        const qty = Number(it?.qty);
        if (!Number.isInteger(qty) || qty < 1 || qty > 50) throw new Error('cantidad invalida');
        const p = db.prepare('SELECT sku, name, price_cents, stock FROM products WHERE sku = ?').get(String(it?.sku)) as any;
        if (!p) throw new Error(`producto inexistente: ${String(it?.sku).slice(0, 30)}`);
        if (p.stock < qty) throw new Error(`stock insuficiente de ${p.name}`);
        total += p.price_cents * qty;
        lines.push({ sku: p.sku, name: p.name, qty, unit: p.price_cents });
      }
      const order = db.prepare('INSERT INTO orders (wa_id, total_cents) VALUES (?, ?)').run(waId, total);
      const id = Number(order.lastInsertRowid);
      for (const l of lines) {
        db.prepare('INSERT INTO order_items (order_id, sku, qty, unit_cents) VALUES (?, ?, ?, ?)').run(id, l.sku, l.qty, l.unit);
        db.prepare('UPDATE products SET stock = stock - ? WHERE sku = ?').run(l.qty, l.sku);
        allowed.add(l.unit);
      }
      db.exec('COMMIT');
      allowed.add(total);
      const detail = lines.map((l) => `${l.qty} x ${l.name}`).join(', ');
      void deps.notifyOwner(`Nuevo pedido #${id} de ${waId}: ${detail}. Total ${money(total)}`);
      return { order_id: id, total: money(total), message: `Listo, pedido #${id} registrado: ${detail}. Total ${money(total)}. Te confirmamos pago y entrega por este chat.` };
    } catch (e) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* sin transaccion activa */
      }
      return { error: (e as Error).message };
    }
  }

  return { error: `herramienta desconocida: ${name}` };
}
