const AMBIGUOUS_RECOMMENDATION_WORDS = /推荐.*模型|哪个模型|选.*模型|推荐一个模型/i;
const DISCOVERY_WORDS = /当前|实时|价格|报价|容量|库存|状态|还能用|可用性|哪个区域|查询.*kai|offer/i;
const LOCK_WORDS = /锁定|预留|购买|成交|占用|下单/i;
const RECEIPT_WORDS = /凭证|receipt|使用记录|消耗记录|结算/i;
const COMPUTE_WORDS = /写|生成|总结|翻译|解释|代码|推理|分析|改写|计算/i;

/** The classifier proposes an intent; it never grants a tool permission. */
export function classifyIntent(input) {
  const text = String(input ?? '').trim();
  if (!text) return { kind: 'ambiguous', confidence: 0, reason: 'empty request' };
  if (LOCK_WORDS.test(text)) return { kind: 'lock', confidence: 0.98, reason: 'explicit lock or purchase language' };
  if (RECEIPT_WORDS.test(text)) return { kind: 'receipt', confidence: 0.96, reason: 'explicit receipt language' };
  if (AMBIGUOUS_RECOMMENDATION_WORDS.test(text)) {
    return { kind: 'ambiguous', confidence: 0.86, reason: 'model recommendation needs confirmation for a live KAI query' };
  }
  if (DISCOVERY_WORDS.test(text)) return { kind: 'discovery', confidence: 0.95, reason: 'explicit dynamic market or availability language' };
  if (COMPUTE_WORDS.test(text)) return { kind: 'compute', confidence: 0.92, reason: 'ordinary compute language' };
  return { kind: 'ambiguous', confidence: 0.4, reason: 'intent needs user confirmation' };
}
