import { createServer, type IncomingMessage as HttpReq, type Server } from 'node:http';
import { handleMessage } from './agent.ts';
import { type Db, recordMessage } from './db.ts';
import type { Llm } from './llm.ts';
import { parseIncoming, sendText, verifyChallenge, verifySignature, type WaConfig } from './whatsapp.ts';

export interface AppConfig {
  verifyToken: string;
  appSecret: string;
  ownerWaId: string;
  wa: WaConfig;
}

export interface App {
  server: Server;
  /** Espera a que terminen los mensajes que se procesan en segundo plano (util en pruebas). */
  idle: () => Promise<void>;
}

const MAX_BODY = 1_000_000;

function readBody(req: HttpReq): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('cuerpo demasiado grande'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export function createApp(cfg: AppConfig, db: Db, llm: Llm, fetchImpl: typeof fetch = fetch): App {
  const pending = new Set<Promise<void>>();
  const notifyOwner = async (text: string) => {
    if (!cfg.ownerWaId) return console.log(`[AVISO AL DUEÑO sin numero configurado] ${text}`);
    await sendText(cfg.wa, cfg.ownerWaId, text, fetchImpl).catch((e) => console.error('aviso al dueño fallo:', e.message));
  };

  async function process(payload: unknown) {
    for (const m of parseIncoming(payload)) {
      if (!recordMessage(db, m.id, m.from, 'in', m.text)) continue; // reintento de Meta: ya procesado
      try {
        const reply = await handleMessage({ db, llm, notifyOwner }, m.from, m.text);
        if (reply) {
          recordMessage(db, `out-${m.id}`, m.from, 'out', reply);
          await sendText(cfg.wa, m.from, reply, fetchImpl);
        }
      } catch (e) {
        console.error('error procesando mensaje', m.id, (e as Error).message);
      }
    }
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const send = (code: number, body = '', type = 'text/plain') => {
      res.writeHead(code, { 'Content-Type': type });
      res.end(body);
    };
    try {
      if (req.method === 'GET' && url.pathname === '/health') return send(200, 'ok');

      if (url.pathname === '/webhook' && req.method === 'GET') {
        const challenge = verifyChallenge(url.searchParams, cfg.verifyToken);
        return challenge === null ? send(403, 'forbidden') : send(200, challenge);
      }

      if (url.pathname === '/webhook' && req.method === 'POST') {
        const raw = await readBody(req);
        if (!verifySignature(raw, req.headers['x-hub-signature-256'] as string | undefined, cfg.appSecret)) {
          return send(401, 'bad signature');
        }
        let payload: unknown;
        try {
          payload = JSON.parse(raw.toString('utf8'));
        } catch {
          return send(400, 'bad json');
        }
        send(200, 'ok'); // Meta exige responder rapido; el trabajo sigue en segundo plano
        const job = process(payload).finally(() => pending.delete(job));
        pending.add(job);
        return;
      }
      send(404, 'not found');
    } catch (e) {
      send(500, 'error');
      console.error((e as Error).message);
    }
  });

  return { server, idle: async () => void (await Promise.all([...pending])) };
}
