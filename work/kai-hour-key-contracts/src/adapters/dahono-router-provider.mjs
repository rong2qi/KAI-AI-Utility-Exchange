const DEFAULT_ENDPOINT = 'https://kai.dahono.com/v1/chat/completions';
const SUPPORTED_MODEL = 'deepseek-v4.1-flash';
const ALLOWED_ENDPOINT_HOST = 'kai.dahono.com';
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_EVENTS = 2048;

const DIAGNOSTIC_HEADERS = Object.freeze([
  ['slotId', 'x-dahono-slot-id', 'string'],
  ['serverRegion', 'x-dahono-server-region', 'string'],
  ['concurrencyActive', 'x-dahono-concurrency-active', 'integer'],
  ['concurrencyRemaining', 'x-dahono-concurrency-remaining', 'integer'],
  ['remainingRpm', 'x-dahono-remaining-rpm', 'integer'],
  ['hourlyReqRemaining', 'x-dahono-hourly-req-remaining', 'integer'],
  ['hourlyTokensInput', 'x-dahono-hourly-tokens-input', 'integer'],
  ['hourlyTokensOutput', 'x-dahono-hourly-tokens-output', 'integer'],
]);

const ALLOWED_ROLES = new Set(['system', 'user', 'assistant', 'tool']);
const RETRYABLE_STATUS = (status) => status === 408 || status === 425 || status === 429 || status >= 500;
const isFiniteNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;
const isPlainObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const safeIntegerHeader = (headers, name) => {
  const raw = headers.get(name);
  if (raw === null || !/^\d+$/.test(raw.trim())) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
};

const normalizeUsage = (usage) => {
  if (!isPlainObject(usage)) return undefined;
  const inputUnits = usage.prompt_tokens;
  const outputUnits = usage.completion_tokens;
  if (!isFiniteNonNegativeInteger(inputUnits) || !isFiniteNonNegativeInteger(outputUnits)) return undefined;
  const totalUnits = usage.total_tokens === undefined ? inputUnits + outputUnits : usage.total_tokens;
  if (!isFiniteNonNegativeInteger(totalUnits)) return undefined;
  return { inputUnits, outputUnits, totalUnits };
};

const validMessage = (message) => {
  if (!isPlainObject(message) || typeof message.role !== 'string' || !ALLOWED_ROLES.has(message.role)) return false;
  if (typeof message.content === 'string') return message.content.length > 0;
  return Array.isArray(message.content)
    && message.content.length > 0
    && message.content.every((part) => isPlainObject(part) && part.type === 'text' && typeof part.text === 'string');
};

const normalizeMessages = (input) => {
  if (typeof input === 'string' && input.length > 0) return [{ role: 'user', content: input }];
  if (!isPlainObject(input)) throw new DahonoProviderError('REQUEST_INVALID', 'Dahono 请求需要 messages 或 prompt');
  if (Array.isArray(input.messages)) {
    if (input.messages.length === 0 || !input.messages.every(validMessage)) {
      throw new DahonoProviderError('REQUEST_INVALID', 'Dahono messages 必须包含受支持的文本消息');
    }
    return clone(input.messages);
  }
  if (typeof input.prompt === 'string' && input.prompt.length > 0) return [{ role: 'user', content: input.prompt }];
  throw new DahonoProviderError('REQUEST_INVALID', 'Dahono 请求需要 messages 或非空 prompt');
};

const normalizeInput = (input) => {
  const payload = { messages: normalizeMessages(input), stream: true, stream_options: { include_usage: true } };
  if (!isPlainObject(input)) return payload;
  if (input.temperature !== undefined) {
    if (typeof input.temperature !== 'number' || !Number.isFinite(input.temperature) || input.temperature < 0 || input.temperature > 2) {
      throw new DahonoProviderError('REQUEST_INVALID', 'Dahono temperature 超出允许范围');
    }
    payload.temperature = input.temperature;
  }
  if (input.top_p !== undefined) {
    if (typeof input.top_p !== 'number' || !Number.isFinite(input.top_p) || input.top_p <= 0 || input.top_p > 1) {
      throw new DahonoProviderError('REQUEST_INVALID', 'Dahono top_p 超出允许范围');
    }
    payload.top_p = input.top_p;
  }
  if (input.max_tokens !== undefined) {
    if (!Number.isSafeInteger(input.max_tokens) || input.max_tokens < 1 || input.max_tokens > 16_384) {
      throw new DahonoProviderError('REQUEST_INVALID', 'Dahono max_tokens 超出允许范围');
    }
    payload.max_tokens = input.max_tokens;
  }
  if (input.user !== undefined) {
    if (typeof input.user !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(input.user)) {
      throw new DahonoProviderError('REQUEST_INVALID', 'Dahono user 只能包含字母、数字、短横线和下划线');
    }
    payload.user = input.user;
  }
  return payload;
};

const parseSseEvents = (text, maxEvents) => {
  const events = [];
  let dataLines = [];
  let sawDone = false;
  const flush = () => {
    if (dataLines.length === 0) return;
    const data = dataLines.join('\n').trim();
    dataLines = [];
    if (data === '[DONE]') {
      sawDone = true;
      return;
    }
    if (sawDone) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono SSE 在结束标记后仍有数据');
    if (events.length >= maxEvents) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono SSE 事件数量超限');
    try {
      events.push(JSON.parse(data));
    } catch {
      throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono SSE 数据不是有效 JSON');
    }
  };

  for (const line of text.split(/\r?\n/)) {
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
  }
  flush();
  if (!sawDone || events.length === 0) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono SSE 缺少完整结束标记');
  return events;
};

const parseDiagnostics = (headers) => {
  const diagnostics = {};
  for (const [property, header, type] of DIAGNOSTIC_HEADERS) {
    if (type === 'string') {
      const value = headers.get(header);
      if (!value) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono 响应缺少诊断头');
      diagnostics[property] = value;
    } else {
      const value = safeIntegerHeader(headers, header);
      if (value === undefined) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono 响应诊断头格式无效');
      diagnostics[property] = value;
    }
  }
  return diagnostics;
};

const parseSseResponse = (text, headers, maxEvents) => {
  const events = parseSseEvents(text, maxEvents);
  let providerRequestId;
  let model;
  let content = '';
  let reasoningContent = '';
  let finishReason = null;
  let usage;
  let sawChoice = false;

  for (const event of events) {
    if (!isPlainObject(event)) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono SSE 事件结构无效');
    if (providerRequestId === undefined && typeof event.id === 'string' && event.id.length > 0) providerRequestId = event.id;
    if (model === undefined && typeof event.model === 'string' && event.model.length > 0) model = event.model;
    if (event.usage !== undefined) {
      usage = normalizeUsage(event.usage);
      if (!usage) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono usage 缺少有效 token 计数');
    }
    if (event.choices !== undefined) {
      if (!Array.isArray(event.choices)) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono choices 结构无效');
      for (const choice of event.choices) {
        if (!isPlainObject(choice)) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono choice 结构无效');
        sawChoice = true;
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (typeof choice.finish_reason !== 'string') throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono finish_reason 结构无效');
          finishReason = choice.finish_reason;
        }
        const delta = choice.delta;
        if (delta !== undefined) {
          if (!isPlainObject(delta)) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono delta 结构无效');
          if (delta.content !== undefined && delta.content !== null) {
            if (typeof delta.content !== 'string') throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono content 结构无效');
            content += delta.content;
          }
          const reasoning = delta.reasoning_content ?? delta.reasoningContent;
          if (reasoning !== undefined && reasoning !== null) {
            if (typeof reasoning !== 'string') throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono reasoning content 结构无效');
            reasoningContent += reasoning;
          }
        }
      }
    }
  }

  if (!providerRequestId || !sawChoice || !usage) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono 响应缺少 id、choices 或 usage');
  return {
    providerRequestId,
    output: {
      content,
      reasoningContent: reasoningContent || null,
      finishReason,
      model: model ?? SUPPORTED_MODEL,
    },
    usage,
    diagnostics: parseDiagnostics(headers),
    status: 'succeeded',
  };
};

const readWithAbort = (operation, signal) => {
  if (!signal) return operation;
  if (signal.aborted) return Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(operation).then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

const readResponseText = async (response, maxBytes, signal) => {
  const chunks = [];
  let size = 0;
  const append = (chunk) => {
    const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono 响应超过大小限制');
    chunks.push(buffer);
  };
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    while (true) {
      const item = await readWithAbort(reader.read(), signal);
      if (item.done) break;
      append(item.value);
    }
  } else if (response.body?.[Symbol.asyncIterator]) {
    const iterator = response.body[Symbol.asyncIterator]();
    while (true) {
      const item = await readWithAbort(iterator.next(), signal);
      if (item.done) break;
      append(item.value);
    }
  } else if (typeof response.text === 'function') {
    append(await readWithAbort(response.text(), signal));
  } else {
    throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono 响应没有可读取内容');
  }
  return Buffer.concat(chunks).toString('utf8');
};

const readSafeErrorCode = async (response, maxBytes, signal) => {
  try {
    const body = JSON.parse(await readResponseText(response, maxBytes, signal));
    const code = body?.error?.code ?? body?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
};

export class DahonoProviderError extends Error {
  constructor(code, message, { retryable = false, status, retryAfter } = {}) {
    super(message);
    this.name = 'DahonoProviderError';
    this.code = code;
    this.retryable = retryable;
    if (status !== undefined) this.status = status;
    if (retryAfter !== undefined) this.retryAfter = retryAfter;
  }
}

export class DahonoRouterProviderAdapter {
  constructor({
    endpoint = DEFAULT_ENDPOINT,
    providerId = 'dahono-router',
    apiKeyResolver = () => process.env.DAHONO_API_KEY,
    fetchImpl = globalThis.fetch,
    networkMode = 'disabled',
    timeoutMs = 15_000,
    maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
    maxEvents = DEFAULT_MAX_EVENTS,
  } = {}) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' || parsed.hostname !== ALLOWED_ENDPOINT_HOST || parsed.pathname !== '/v1/chat/completions' || parsed.search || parsed.hash) {
      throw new Error('DAHONO_ENDPOINT_NOT_ALLOWED');
    }
    if (!providerId) throw new Error('DAHONO_PROVIDER_ID_REQUIRED');
    if (typeof fetchImpl !== 'function') throw new Error('DAHONO_FETCH_REQUIRED');
    if (typeof apiKeyResolver !== 'function') throw new Error('DAHONO_API_KEY_RESOLVER_REQUIRED');
    if (!['disabled', 'live'].includes(networkMode)) throw new Error('DAHONO_NETWORK_MODE_INVALID');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('DAHONO_TIMEOUT_INVALID');
    if (!Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) throw new Error('DAHONO_MAX_RESPONSE_INVALID');
    if (!Number.isSafeInteger(maxEvents) || maxEvents <= 0) throw new Error('DAHONO_MAX_EVENTS_INVALID');
    this.endpoint = parsed.toString();
    this.providerId = providerId;
    this.apiKeyResolver = apiKeyResolver;
    this.fetchImpl = fetchImpl;
    this.networkMode = networkMode;
    this.timeoutMs = timeoutMs;
    this.maxResponseBytes = maxResponseBytes;
    this.maxEvents = maxEvents;
  }

  async execute(request) {
    this.#validateRequest(request);
    if (request.model !== SUPPORTED_MODEL) throw new DahonoProviderError('PROVIDER_SCOPE_UNSUPPORTED', 'Dahono 模型不在已声明的适配范围内');
    if (this.networkMode === 'disabled') throw new DahonoProviderError('PROVIDER_NETWORK_DISABLED', 'Dahono 网络适配器默认关闭，必须由受保护入口显式启用');

    let key;
    try {
      key = await this.apiKeyResolver();
    } catch {
      throw new DahonoProviderError('PROVIDER_CREDENTIAL_UNAVAILABLE', 'Dahono API 密钥读取失败');
    }
    if (typeof key !== 'string' || key.trim().length === 0) throw new DahonoProviderError('PROVIDER_CREDENTIAL_REQUIRED', '未找到 Dahono API 密钥');

    const payload = normalizeInput(request.input);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.trim()}`,
          accept: 'text/event-stream',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: request.model, ...payload }),
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      if (error?.name === 'AbortError' || controller.signal.aborted) throw new DahonoProviderError('PROVIDER_TIMEOUT', 'Dahono 请求超时', { retryable: true });
      throw new DahonoProviderError('PROVIDER_UNAVAILABLE', 'Dahono 接口无法访问', { retryable: true });
    }

    if (!response || typeof response.status !== 'number') {
      clearTimeout(timer);
      throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono 响应结构无效');
    }
    if (!response.ok) {
      const upstreamCode = response.status === 403
        ? await readSafeErrorCode(response, this.maxResponseBytes, controller.signal)
        : undefined;
      clearTimeout(timer);
      const retryAfterRaw = response.headers?.get('retry-after');
      const retryAfter = retryAfterRaw && /^\d+$/.test(retryAfterRaw.trim()) ? Number(retryAfterRaw) : undefined;
      if (response.status === 401) throw new DahonoProviderError('PROVIDER_CREDENTIAL_INVALID', 'Dahono API 密钥未获授权', { status: response.status });
      if (response.status === 403 && upstreamCode === '403_OUTSIDE_RESERVED_WINDOW') throw new DahonoProviderError('PROVIDER_WINDOW_CLOSED', 'Dahono 预约窗口未开放', { status: response.status });
      if (response.status === 403) throw new DahonoProviderError('PROVIDER_HTTP_ERROR', 'Dahono 上游返回 HTTP 错误', { retryable: false, status: response.status });
      if (response.status === 429) throw new DahonoProviderError('PROVIDER_RATE_LIMITED', 'Dahono 请求达到速率限制', { retryable: true, status: response.status, retryAfter });
      throw new DahonoProviderError('PROVIDER_HTTP_ERROR', 'Dahono 上游返回 HTTP 错误', { retryable: RETRYABLE_STATUS(response.status), status: response.status });
    }

    try {
      const text = await readResponseText(response, this.maxResponseBytes, controller.signal);
      return parseSseResponse(text, response.headers, this.maxEvents);
    } catch (error) {
      if (error instanceof DahonoProviderError) throw error;
      if (error?.name === 'AbortError' || controller.signal.aborted) throw new DahonoProviderError('PROVIDER_TIMEOUT', 'Dahono 响应读取超时', { retryable: true });
      throw new DahonoProviderError('PROVIDER_RESPONSE_INVALID', 'Dahono 响应无法解析');
    } finally {
      clearTimeout(timer);
    }
  }

  #validateRequest(request) {
    if (!isPlainObject(request) || typeof request.model !== 'string' || typeof request.region !== 'string' || request.region.length === 0) {
      throw new DahonoProviderError('REQUEST_INVALID', 'Dahono 请求需要 model 和 region');
    }
    if (typeof request.requestId !== 'string' || request.requestId.length === 0 || typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length < 8) {
      throw new DahonoProviderError('REQUEST_INVALID', 'Dahono 请求需要 requestId 和至少 8 个字符的幂等键');
    }
  }
}

export const DAHONO_ROUTER_DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;
export const DAHONO_ROUTER_MODEL = SUPPORTED_MODEL;
export const DAHONO_ROUTER_DIAGNOSTIC_HEADERS = DIAGNOSTIC_HEADERS.map(([, header]) => header);
export { parseSseEvents as parseDahonoSseEvents };
