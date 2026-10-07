import { ApiError, badRequest } from '@nexus/service-kit';

const DEFAULTS = {
  nvidia: { url: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'nvidia/nemotron-3-ultra-550b-a55b' },
  anthropic: { url: 'https://api.anthropic.com/v1/messages', model: 'claude-sonnet-5-5' },
};

export function resolveProvider(config) {
  const provider = config.aiProvider || 'nvidia';
  if (!DEFAULTS[provider]) throw badRequest('AI_PROVIDER must be nvidia or anthropic.');
  const key = (provider === 'anthropic' ? config.anthropicApiKey : config.nvidiaApiKey) || config.aiApiKey || '';
  const keyName = provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'NVIDIA_API_KEY';
  const url = provider === 'anthropic' ? config.anthropicApiUrl || DEFAULTS.anthropic.url
    : config.nvidiaApiUrl || (config.aiBaseUrl ? `${config.aiBaseUrl.replace(/\/$/, '')}/chat/completions` : DEFAULTS.nvidia.url);
  const model = config.supportAiModel || config.aiModel || DEFAULTS[provider].model;
  let problem = !key ? `Set ${keyName} on the AI server to enable chat.` : null;
  if (provider === 'anthropic' && key.startsWith('nvapi-')) problem = 'This is an NVIDIA key. Set ANTHROPIC_API_KEY to a key issued by Anthropic, or select AI_PROVIDER=nvidia.';
  if (provider === 'nvidia' && key.startsWith('sk-ant-')) problem = 'This is an Anthropic key. Set AI_PROVIDER=anthropic or provide an NVIDIA key.';
  if (provider === 'anthropic' && model.startsWith('nvidia/')) problem = 'Set SUPPORT_AI_MODEL to an Anthropic model when AI_PROVIDER=anthropic.';
  return { provider, key, keyName, url, model, configured: !problem, problem };
}

// Keep one internal chat format while speaking each provider's native API.
export function anthropicMessages(history) {
  const messages = [];
  for (const message of history.filter((item) => item.role !== 'system')) {
    let role = message.role;
    let content;
    if (role === 'tool') {
      role = 'user'; content = [{ type: 'tool_result', tool_use_id: message.tool_call_id, content: message.content }];
    } else {
      content = message.providerContent ?? [
        ...(message.content ? [{ type: 'text', text: message.content }] : []),
        ...(message.tool_calls ?? []).map((call) => ({ type: 'tool_use', id: call.id, name: call.function.name, input: JSON.parse(call.function.arguments) })),
      ];
    }
    if (messages.at(-1)?.role === role) messages.at(-1).content.push(...content);
    else messages.push({ role, content });
  }
  return messages;
}

function providerError(status) {
  if ([401, 403].includes(status)) return new ApiError(502, 'ai_auth_failed', 'The AI provider rejected the key or its permissions. Check the selected provider and server API key.');
  if (status === 404) return new ApiError(502, 'ai_model_not_found', 'The selected model or API URL is unavailable. Check SUPPORT_AI_MODEL and the provider URL.');
  if (status === 429) return new ApiError(429, 'ai_rate_limited', 'The AI provider quota or rate limit has been reached. Please try again later.');
  if (status >= 500) return new ApiError(502, 'ai_provider_overloaded', 'The AI provider is temporarily overloaded. Please try again shortly.');
  return new ApiError(502, 'ai_request_rejected', 'The AI provider rejected this request. Check the model and provider configuration.');
}

export async function complete({ config, history, tools, lastTurn = false, fetcher = fetch, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const selected = resolveProvider(config);
  if (!selected.configured) throw new ApiError(503, 'ai_not_configured', selected.problem);
  let url;
  try { url = new URL(selected.url); } catch { throw badRequest('The model API URL is invalid.'); }
  if (url.username || url.password || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw badRequest('The model API must use HTTPS.');
  const anthropic = selected.provider === 'anthropic';
  const payload = anthropic ? {
    model: selected.model, max_tokens: 4096,
    system: history.filter((m) => m.role === 'system').map((m) => m.content).join('\n'),
    messages: anthropicMessages(history),
    ...(tools ? { tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema })), tool_choice: { type: lastTurn ? 'none' : 'auto' } } : {}),
  } : {
    model: selected.model, max_tokens: 4096, temperature: 0.2,
    messages: history.map(({ providerContent: _ignored, ...message }) => message),
    ...(tools ? { tools: tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: lastTurn ? 'none' : 'auto', parallel_tool_calls: false } : {}),
  };
  let response;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(45000),
        headers: { 'content-type': 'application/json', ...(anthropic ? { 'x-api-key': selected.key, 'anthropic-version': '2023-06-01' } : { authorization: `Bearer ${selected.key}` }) }, body: JSON.stringify(payload) });
    } catch { throw new ApiError(502, 'model_unavailable', 'The AI provider did not respond. Please try again.'); }
    if (attempt === 0 && [429, 502, 503, 504, 529].includes(response.status)) {
      await response.body?.cancel();
      await wait(750); continue;
    }
    break;
  }
  if (!response.ok) { await response.body?.cancel(); throw providerError(response.status); }
  const raw = await response.text();
  if (raw.length > 250000) throw new ApiError(502, 'model_response_invalid', 'The model response was too large.');
  let data;
  try { data = JSON.parse(raw); } catch { throw new ApiError(502, 'model_response_invalid', 'The model returned an invalid response.'); }
  let message;
  if (anthropic && Array.isArray(data.content)) {
    message = { content: data.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'), providerContent: data.content,
      tool_calls: data.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input) } })) };
  } else message = data.choices?.[0]?.message;
  if (!message || (!message.content?.trim() && !message.tool_calls?.length)) throw new ApiError(502, 'model_response_empty', 'The model returned no answer. Please retry or choose another model.');
  return message;
}
