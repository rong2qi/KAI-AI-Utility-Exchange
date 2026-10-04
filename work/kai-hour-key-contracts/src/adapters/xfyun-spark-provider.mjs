import { execFile } from 'node:child_process';

const DEFAULT_ENDPOINT = 'https://maas-api.cn-huabei-1.xf-yun.com/v2/chat/completions';
const SUPPORTED_MODELS = Object.freeze(['spark-x2.5', 'spark-x2.5-4b', 'spark-x2.5-1.7b']);
const RETRYABLE_HTTP_STATUSES = new Set([408, 425, 429]);

const clone = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const isFiniteNonNegativeInteger = (value) => Number.isInteger(value) && value >= 0;

const usageUnits = (body) => {
  const usage = body?.usage;
  if (!usage || typeof usage !== 'object') return { inputUnits: 0, outputUnits: 0, totalUnits: 0 };
  const inputUnits = isFiniteNonNegativeInteger(usage.prompt_tokens) ? usage.prompt_tokens : 0;
  const outputUnits = isFiniteNonNegativeInteger(usage.completion_tokens) ? usage.completion_tokens : 0;
  const documentedTotal = isFiniteNonNegativeInteger(usage.total_tokens) ? usage.total_tokens : inputUnits + outputUnits;
  return { inputUnits, outputUnits, totalUnits: documentedTotal };
};

const retryableForStatus = (status) => RETRYABLE_HTTP_STATUSES.has(status) || status >= 500;

const allowedMessage = (message) => {
  if (!message || typeof message !== 'object' || typeof message.role !== 'string') return false;
  if (!['system', 'user', 'assistant', 'tool'].includes(message.role)) return false;
  return typeof message.content === 'string'
    || (Array.isArray(message.content) && message.content.every((part) => part?.type === 'text' && typeof part.text === 'string'));
};

const normalizeInput = (input) => {
  if (!input || typeof input !== 'object' || !Array.isArray(input.messages) || input.messages.length === 0) {
    throw new XfyunProviderError('REQUEST_INVALID', '讯飞请求至少需要一条 messages 消息');
  }
  if (!input.messages.every(allowedMessage)) {
    throw new XfyunProviderError('REQUEST_INVALID', '讯飞消息必须使用受支持的 role 和文本 content');
  }
  if (input.stream === true) {
    throw new XfyunProviderError('REQUEST_STREAM_UNSUPPORTED', '讯飞适配器当前只接受非流式请求');
  }
  if (input.user !== undefined && (typeof input.user !== 'string' || !/^[A-Za-z0-9_-]{1,512}$/.test(input.user))) {
    throw new XfyunProviderError('REQUEST_INVALID', '讯飞 user 只能包含字母、数字、短横线和下划线，长度不超过 512');
  }
  const payload = {
    messages: clone(input.messages),
    stream: false,
  };
  if (input.user !== undefined) payload.user = input.user;
  if (input.thinking !== undefined) {
    if (!input.thinking || !['enabled', 'disabled', 'auto'].includes(input.thinking.type)) {
      throw new XfyunProviderError('REQUEST_INVALID', '讯飞 thinking.type 必须是 enabled、disabled 或 auto');
    }
    payload.thinking = { type: input.thinking.type };
  }
  return payload;
};

export class XfyunProviderError extends Error {
  constructor(code, message, { retryable = false, cause, status } = {}) {
    super(message, { cause });
    this.name = 'XfyunProviderError';
    this.code = code;
    this.retryable = retryable;
    this.status = status;
  }
}

/**
 * Adapter for the documented non-streaming iFlytek Spark Chat endpoint.
 * The key is resolved inside this adapter and is never returned in errors or results.
 * The endpoint does not advertise idempotency, so effective-once behavior remains
 * the responsibility of UsageExecutionLedger and its recorded Provider result.
 */
export class XfyunSparkProviderAdapter {
  constructor({
    endpoint = DEFAULT_ENDPOINT,
    providerId = 'xfyun-spark-chat',
    apiKeyResolver = () => process.env.XFYUN_API_KEY,
    fetchImpl = globalThis.fetch,
    networkMode = 'disabled',
    timeoutMs = 15_000,
  } = {}) {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'maas-api.cn-huabei-1.xf-yun.com' || parsed.pathname !== '/v2/chat/completions') {
      throw new Error('XFYUN_ENDPOINT_NOT_ALLOWED');
    }
    if (!providerId) throw new Error('XFYUN_PROVIDER_ID_REQUIRED');
    if (typeof fetchImpl !== 'function') throw new Error('XFYUN_FETCH_REQUIRED');
    if (!['disabled', 'live'].includes(networkMode)) throw new Error('XFYUN_NETWORK_MODE_INVALID');
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('XFYUN_TIMEOUT_INVALID');
    if (typeof apiKeyResolver !== 'function') throw new Error('XFYUN_API_KEY_RESOLVER_REQUIRED');
    this.endpoint = parsed.toString();
    this.providerId = providerId;
    this.apiKeyResolver = apiKeyResolver;
    this.fetchImpl = fetchImpl;
    this.networkMode = networkMode;
    this.timeoutMs = timeoutMs;
  }

  async execute(request) {
    this.#validateRequest(request);
    if (!SUPPORTED_MODELS.includes(request.model)) {
      throw new XfyunProviderError('PROVIDER_SCOPE_UNSUPPORTED', '讯飞模型不在已声明的适配范围内');
    }
    if (this.networkMode === 'disabled') {
      throw new XfyunProviderError('PROVIDER_NETWORK_DISABLED', '讯飞网络适配器默认关闭，必须由受保护入口显式启用');
    }
    let key;
    try {
      key = await this.apiKeyResolver();
    } catch (error) {
      throw new XfyunProviderError('PROVIDER_CREDENTIAL_UNAVAILABLE', '讯飞 API 密钥读取失败', { cause: error });
    }
    if (typeof key !== 'string' || key.trim().length === 0) {
      throw new XfyunProviderError('PROVIDER_CREDENTIAL_REQUIRED', '未找到讯飞 API 密钥');
    }
    const input = normalizeInput(request.input);
    const body = JSON.stringify({ model: request.model, ...input });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key.trim()}`,
          'content-type': 'application/json',
        },
        body,
        redirect: 'error',
        signal: controller.signal,
      });
    } catch (error) {
      if (error?.name === 'AbortError') {
        throw new XfyunProviderError('PROVIDER_TIMEOUT', '讯飞请求超时', { retryable: true, cause: error });
      }
      throw new XfyunProviderError('PROVIDER_UNAVAILABLE', '讯飞接口无法访问', { retryable: true, cause: error });
    } finally {
      clearTimeout(timer);
    }

    let responseBody;
    try {
      responseBody = await response.json();
    } catch (error) {
      throw new XfyunProviderError('PROVIDER_RESPONSE_INVALID', '讯飞响应不是有效 JSON', {
        retryable: response.status >= 500,
        cause: error,
        status: response.status,
      });
    }
    if (!response.ok) {
      throw new XfyunProviderError('PROVIDER_HTTP_ERROR', '讯飞接口返回 HTTP 错误', {
        retryable: retryableForStatus(response.status),
        status: response.status,
      });
    }
    if (responseBody?.code !== undefined && responseBody.code !== 0) {
      throw new XfyunProviderError('PROVIDER_BUSINESS_ERROR', '讯飞接口返回业务错误', {
        retryable: false,
        status: response.status,
      });
    }
    if (typeof responseBody?.id !== 'string' || !Array.isArray(responseBody.choices) || responseBody.choices.length === 0) {
      throw new XfyunProviderError('PROVIDER_RESPONSE_INVALID', '讯飞响应缺少 id 或 choices', { status: response.status });
    }
    const choice = responseBody.choices[0];
    if (!choice?.message || typeof choice.message !== 'object') {
      throw new XfyunProviderError('PROVIDER_RESPONSE_INVALID', '讯飞响应缺少 assistant message', { status: response.status });
    }
    return {
      providerRequestId: responseBody.id,
      output: {
        content: choice.message.content ?? null,
        reasoningContent: choice.message.reasoning_content ?? null,
        finishReason: choice.finish_reason ?? null,
        model: responseBody.model ?? request.model,
      },
      usage: usageUnits(responseBody),
      status: 'succeeded',
    };
  }

  #validateRequest(request) {
    if (!request || typeof request !== 'object' || typeof request.model !== 'string' || typeof request.region !== 'string') {
      throw new XfyunProviderError('REQUEST_INVALID', '讯飞请求需要 model 和 region');
    }
    if (typeof request.requestId !== 'string' || request.requestId.length === 0 || typeof request.idempotencyKey !== 'string' || request.idempotencyKey.length < 8) {
      throw new XfyunProviderError('REQUEST_INVALID', '讯飞请求需要 requestId 和至少 8 个字符的幂等键');
    }
  }
}

export const XFYUN_SPARK_DEFAULT_ENDPOINT = DEFAULT_ENDPOINT;
export const XFYUN_SPARK_SUPPORTED_MODELS = SUPPORTED_MODELS;

/**
 * Reads a macOS Keychain generic password without putting its value in a
 * command line, log, evidence file, or thrown error.
 */
export const createMacKeychainApiKeyResolver = ({
  service = 'kai-xfyun-api-key',
  account = process.env.USER,
  execFileImpl = execFile,
} = {}) => {
  if (!service || !account || typeof execFileImpl !== 'function') throw new Error('XFYUN_KEYCHAIN_CONFIG_INVALID');
  return () => new Promise((resolve, reject) => {
    execFileImpl('security', ['find-generic-password', '-a', account, '-s', service, '-w'], { encoding: 'utf8' }, (error, stdout) => {
      if (error) {
        reject(new Error('XFYUN_KEYCHAIN_READ_FAILED'));
        return;
      }
      const key = stdout.trim();
      resolve(key || undefined);
    });
  });
};
