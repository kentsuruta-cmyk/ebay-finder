// Anthropic 公式SDKの薄いラッパー。
// 以前は生fetch + 正規表現でJSONを切り出していたが、構造が崩れると全件フォールバックしていた。
// structured outputs を使うとスキーマ違反のレスポンスがそもそも返らない。
const Anthropic = require('@anthropic-ai/sdk');
const { zodOutputFormat } = require('@anthropic-ai/sdk/helpers/zod');

const MODEL = 'claude-opus-5';

let client = null;
function getClient() {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY が設定されていません');
    client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
  return client;
}

// スキーマに沿ったJSONを取り出す。parsed_output が null なら例外を投げて
// 呼び出し側にフォールバックさせる（黙って空を返さない）。
async function parseJson({ schema, schemaName, prompt, system, maxTokens = 16000, effort = 'high', tools }) {
  const res = await getClient().messages.parse({
    model: MODEL,
    max_tokens: maxTokens,
    thinking: { type: 'adaptive' },
    output_config: { effort, format: zodOutputFormat(schema, schemaName) },
    ...(system ? { system } : {}),
    ...(tools ? { tools } : {}),
    messages: [{ role: 'user', content: prompt }],
  });
  if (res.stop_reason === 'refusal') {
    throw new Error(`Claudeが応答を拒否しました (${res.stop_details?.category || 'unknown'})`);
  }
  if (!res.parsed_output) throw new Error('Claudeの応答をスキーマに沿って解釈できませんでした');
  return res.parsed_output;
}

// 構造化出力を使えないケース（Web検索ツール併用など）向けのプレーンテキスト版。
// サーバー側ツールが長引くと stop_reason が pause_turn で返るので、継続して回す。
async function text({ prompt, system, maxTokens = 16000, effort = 'high', tools, maxTurns = 4 }) {
  const messages = [{ role: 'user', content: prompt }];
  let res;
  for (let turn = 0; turn < maxTurns; turn++) {
    res = await getClient().messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      thinking: { type: 'adaptive' },
      output_config: { effort },
      ...(system ? { system } : {}),
      ...(tools ? { tools } : {}),
      messages,
    });
    if (res.stop_reason === 'refusal') {
      throw new Error(`Claudeが応答を拒否しました (${res.stop_details?.category || 'unknown'})`);
    }
    if (res.stop_reason !== 'pause_turn') break;
    messages.push({ role: 'assistant', content: res.content });
  }
  return res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
}

module.exports = { MODEL, getClient, parseJson, text };
