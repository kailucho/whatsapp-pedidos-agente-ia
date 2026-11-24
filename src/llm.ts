export interface ToolCall {
  id: string;
  name: string;
  arguments: string; // JSON
}
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}
export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}
export interface LlmResult {
  content?: string;
  tool_calls?: ToolCall[];
}
export interface Llm {
  chat(messages: ChatMessage[], tools: ToolDef[]): Promise<LlmResult>;
}

/** Cliente para cualquier endpoint compatible con OpenAI (/chat/completions) con tool-calling. */
export function openAiLlm(baseUrl: string, apiKey: string, model: string, fetchImpl: typeof fetch = fetch): Llm {
  return {
    async chat(messages, tools) {
      const res = await fetchImpl(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          temperature: 0.2,
          messages: messages.map((m) => ({
            role: m.role,
            content: m.content ?? null,
            ...(m.tool_calls ? { tool_calls: m.tool_calls.map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) } : {}),
            ...(m.tool_call_id ? { tool_call_id: m.tool_call_id } : {}),
          })),
          tools: tools.map((t) => ({ type: 'function', function: t })),
        }),
      });
      if (!res.ok) throw new Error(`LLM ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const msg = ((await res.json()) as any).choices?.[0]?.message ?? {};
      return {
        content: msg.content ?? undefined,
        tool_calls: (msg.tool_calls ?? []).map((t: any) => ({ id: t.id, name: t.function?.name, arguments: t.function?.arguments ?? '{}' })),
      };
    },
  };
}

/**
 * Modelo SIMULADO y determinista, para pruebas y DRY_RUN sin costo.
 * Sigue el mismo contrato de tool-calling que un modelo real, pero con reglas simples.
 */
export function mockLlm(): Llm {
  let n = 0;
  const call = (name: string, args: object): LlmResult => ({ tool_calls: [{ id: `mock-${++n}`, name, arguments: JSON.stringify(args) }] });
  return {
    async chat(messages) {
      const last = messages[messages.length - 1];
      const userText = [...messages].reverse().find((m) => m.role === 'user')?.content ?? '';
      if (last.role === 'user') {
        if (/humano|asesor|reclamo|persona|queja/i.test(userText)) return call('escalate_to_human', { reason: userText.slice(0, 200) });
        return call('list_catalog', {});
      }
      if (last.role === 'tool') {
        const result = JSON.parse(last.content ?? '{}');
        const prev = messages[messages.length - 2];
        const toolName = prev?.tool_calls?.find((t) => t.id === last.tool_call_id)?.name;
        if (toolName === 'escalate_to_human') return { content: 'Te paso con una persona del equipo. Te escribira pronto.' };
        if (toolName === 'create_order') return { content: result.error ? `No pude registrar el pedido: ${result.error}` : result.message };
        if (toolName === 'list_catalog') {
          const products: { sku: string; name: string; price: string }[] = result.products ?? [];
          const items: { sku: string; qty: number }[] = [];
          if (/quiero|pedir|pedido|llevo|dame|confirmo/i.test(userText)) {
            for (const p of products) {
              const m = userText.toLowerCase().match(new RegExp(`(?:(\\d+)\\s*(?:x\\s*)?(?:de\\s+)?)?${p.name.toLowerCase()}`));
              if (m) items.push({ sku: p.sku, qty: m[1] ? parseInt(m[1], 10) : 1 });
            }
          }
          if (items.length) return call('create_order', { items });
          const lines = products.map((p) => `- ${p.name}: ${p.price}`).join('\n');
          return { content: `Hola! Este es nuestro catalogo:\n${lines}\nDime que quieres pedir (por ejemplo: "quiero 2 brownie").` };
        }
      }
      return { content: 'No entendi. Puedes escribir "catalogo" o pedir un producto.' };
    },
  };
}
