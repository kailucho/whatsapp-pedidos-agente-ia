import { openDb, seed } from './db.ts';
import { mockLlm, openAiLlm } from './llm.ts';
import { createApp } from './server.ts';

const env = process.env;
const dryRun = env.DRY_RUN !== '0';

if (!env.APP_SECRET) {
  console.error('Falta APP_SECRET (secreto de la app de Meta). Sin el no se puede validar la firma de los webhooks.');
  process.exit(1);
}
if (!dryRun && (!env.WA_TOKEN || !env.PHONE_NUMBER_ID)) {
  console.error('Con DRY_RUN=0 hacen falta WA_TOKEN y PHONE_NUMBER_ID.');
  process.exit(1);
}

const db = openDb(env.DB_PATH || './pedidos.db');
seed(db);

const llm = env.LLM_BASE_URL && env.LLM_API_KEY && env.LLM_MODEL ? openAiLlm(env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL) : mockLlm();
console.log(env.LLM_BASE_URL ? `LLM real: ${env.LLM_MODEL}` : 'LLM simulado (sin costo)');
console.log(dryRun ? 'DRY_RUN activo: no se envia nada a Meta.' : 'Envio real activado.');

const app = createApp(
  {
    verifyToken: env.VERIFY_TOKEN || '',
    appSecret: env.APP_SECRET,
    ownerWaId: env.OWNER_WA_ID || '',
    wa: { dryRun, token: env.WA_TOKEN || '', phoneNumberId: env.PHONE_NUMBER_ID || '', graphVersion: env.GRAPH_VERSION || 'v21.0' },
  },
  db,
  llm,
);

const port = Number(env.PORT || 3000);
app.server.listen(port, () => console.log(`Webhook escuchando en http://localhost:${port}/webhook`));
