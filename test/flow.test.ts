import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { handleMessage } from '../src/agent.ts';
import { openDb, seed, type Db } from '../src/db.ts';
import { mockLlm, type Llm } from '../src/llm.ts';
import { createApp, type App } from '../src/server.ts';
import { parseIncoming, verifyChallenge, verifySignature } from '../src/whatsapp.ts';

const SECRET = 'secreto-de-prueba';
const VERIFY = 'token-verificacion';
const sign = (body: string, secret = SECRET) => 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

/** Forma del payload segun la documentacion de la Cloud API de WhatsApp. */
const payload = (id: string, from: string, body: string) => ({
  object: 'whatsapp_business_account',
  entry: [
    {
      id: '123456789',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550000000', phone_number_id: '111222333' },
            contacts: [{ profile: { name: 'Cliente Prueba' }, wa_id: from }],
            messages: [{ from, id, timestamp: '1700000000', type: 'text', text: { body } }],
          },
        },
      ],
    },
  ],
});

describe('whatsapp: firma, desafio y lectura de payloads', () => {
  it('acepta una firma valida y rechaza una alterada', () => {
    const body = '{"a":1}';
    assert.equal(verifySignature(body, sign(body), SECRET), true);
    assert.equal(verifySignature(body, sign(body, 'otro'), SECRET), false);
    assert.equal(verifySignature(body + ' ', sign(body), SECRET), false);
    assert.equal(verifySignature(body, undefined, SECRET), false);
    assert.equal(verifySignature(body, 'sha256=zzzz', SECRET), false);
  });

  it('responde el challenge solo con el token correcto', () => {
    const ok = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': VERIFY, 'hub.challenge': '1158201444' });
    assert.equal(verifyChallenge(ok, VERIFY), '1158201444');
    const bad = new URLSearchParams({ 'hub.mode': 'subscribe', 'hub.verify_token': 'x', 'hub.challenge': '1' });
    assert.equal(verifyChallenge(bad, VERIFY), null);
  });

  it('ignora statuses y tipos no soportados, lee texto y botones', () => {
    const statusOnly = { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: { statuses: [{ id: 'x', status: 'read' }] } }] }] };
    assert.deepEqual(parseIncoming(statusOnly), []);
    const image = payload('wamid.1', '51900000001', 'x');
    (image.entry[0].changes[0].value.messages[0] as any).type = 'image';
    assert.deepEqual(parseIncoming(image), []);
    const btn = payload('wamid.2', '51900000001', 'x');
    Object.assign(btn.entry[0].changes[0].value.messages[0], { type: 'interactive', interactive: { button_reply: { id: 'si', title: 'Si, confirmo' } } });
    assert.equal(parseIncoming(btn)[0].text, 'Si, confirmo');
    assert.deepEqual(parseIncoming({ object: 'page' }), []);
  });
});

describe('agente: pedidos, catalogo y seguridad', () => {
  let db: Db;
  const avisos: string[] = [];
  const deps = () => ({ db, llm: mockLlm(), notifyOwner: async (t: string) => void avisos.push(t) });
  before(() => {
    db = openDb();
    seed(db);
  });

  it('muestra el catalogo con precios de la base', async () => {
    const r = await handleMessage(deps(), '51911111111', 'hola');
    assert.match(r!, /Brownie: S\/ 7\.00/);
    assert.match(r!, /Cafe latte: S\/ 10\.00/);
  });

  it('crea un pedido, calcula el total en codigo, descuenta stock y avisa al dueño', async () => {
    const r = await handleMessage(deps(), '51911111111', 'quiero 2 brownie y 1 cafe latte');
    assert.match(r!, /Total S\/ 24\.00/);
    const stock = (db.prepare("SELECT stock FROM products WHERE sku='BROWNIE'").get() as any).stock;
    assert.equal(stock, 23);
    assert.ok(avisos.some((a) => /Nuevo pedido/.test(a) && /24\.00/.test(a)));
  });

  it('rechaza pedidos con stock insuficiente sin crear nada', async () => {
    const antes = (db.prepare('SELECT COUNT(*) c FROM orders').get() as any).c;
    const r = await handleMessage(deps(), '51922222222', 'quiero 99 brownie');
    assert.match(r!, /No pude registrar/);
    assert.equal((db.prepare('SELECT COUNT(*) c FROM orders').get() as any).c, antes);
  });

  it('pasa a una persona, avisa al dueño y luego el bot calla', async () => {
    const r = await handleMessage(deps(), '51933333333', 'quiero hablar con un asesor, tengo un reclamo');
    assert.match(r!, /persona/);
    assert.ok(avisos.some((a) => /atencion humana/.test(a)));
    assert.equal(await handleMessage(deps(), '51933333333', 'hola?'), null);
  });

  it('bloquea una respuesta del modelo que inventa un precio', async () => {
    const mentiroso: Llm = { chat: async () => ({ content: 'El brownie cuesta S/ 1.00 hoy!' }) };
    const r = await handleMessage({ db, llm: mentiroso, notifyOwner: async (t) => void avisos.push(t) }, '51944444444', 'cuanto cuesta el brownie?');
    assert.match(r!, /No tengo ese dato confirmado/);
    assert.ok(avisos.some((a) => /bloqueada por seguridad/.test(a)));
  });
});

describe('servidor HTTP del webhook', () => {
  let app: App;
  let base: string;
  let db: Db;
  const enviados: string[] = [];
  before(async () => {
    db = openDb();
    seed(db);
    const fakeFetch = (async (_url: string, init: any) => {
      enviados.push(JSON.parse(init.body).text.body);
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    app = createApp(
      { verifyToken: VERIFY, appSecret: SECRET, ownerWaId: '51999999999', wa: { dryRun: false, token: 't', phoneNumberId: '111', graphVersion: 'v21.0' } },
      db,
      mockLlm(),
      fakeFetch,
    );
    await new Promise<void>((r) => app.server.listen(0, r));
    base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });
  after(() => app.server.close());

  it('GET /webhook valida el token', async () => {
    const ok = await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=${VERIFY}&hub.challenge=abc`);
    assert.equal(ok.status, 200);
    assert.equal(await ok.text(), 'abc');
    assert.equal((await fetch(`${base}/webhook?hub.mode=subscribe&hub.verify_token=mal&hub.challenge=abc`)).status, 403);
  });

  it('POST sin firma o con firma falsa da 401 y no procesa nada', async () => {
    const body = JSON.stringify(payload('wamid.sin', '51955555555', 'hola'));
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body })).status, 401);
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body, headers: { 'x-hub-signature-256': sign(body, 'otro') } })).status, 401);
    await app.idle();
    assert.equal(enviados.length, 0);
  });

  it('POST firmado responde 200, contesta por la Cloud API y no repite un reintento', async () => {
    const body = JSON.stringify(payload('wamid.uno', '51966666666', 'hola'));
    const headers = { 'x-hub-signature-256': sign(body), 'content-type': 'application/json' };
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body, headers })).status, 200);
    await app.idle();
    assert.equal(enviados.length, 1);
    assert.match(enviados[0], /catalogo/i);
    // Meta reenvia el mismo mensaje: no debe contestar dos veces
    assert.equal((await fetch(`${base}/webhook`, { method: 'POST', body, headers })).status, 200);
    await app.idle();
    assert.equal(enviados.length, 1);
  });
});
