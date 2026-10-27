import { guard, body, cleanAttachments, readUpstream } from '../lib/common.js';

const TIMEOUT_MS = 55000;

function clampTokens(n, fallback) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.min(Math.max(Math.round(v), 200), 4000);
}

// ---------------- Claude ----------------
async function askClaude({ system, prompt, attachments, maxTokens }) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY غير مضبوط');
  const content = [];
  for (const a of attachments) {
    if (a.mime === 'application/pdf') {
      content.push({ type: 'document', source: { type: 'base64', media_type: a.mime, data: a.data } });
    } else {
      content.push({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.data } });
    }
  }
  content.push({ type: 'text', text: prompt });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await readUpstream(r, 'Claude');
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
  if (!text) throw new Error('Claude: رد فاضي');
  return text;
}

// ---------------- ChatGPT (OpenAI) ----------------
async function askOpenAI({ system, prompt, attachments, maxTokens }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY غير مضبوط');
  const content = [];
  for (const a of attachments) {
    if (a.mime === 'application/pdf') {
      content.push({
        type: 'file',
        file: { filename: a.name.endsWith('.pdf') ? a.name : `${a.name}.pdf`, file_data: `data:application/pdf;base64,${a.data}` },
      });
    } else {
      content.push({ type: 'image_url', image_url: { url: `data:${a.mime};base64,${a.data}` } });
    }
  }
  content.push({ type: 'text', text: prompt });
  const payload = {
    model: process.env.OPENAI_MODEL || 'gpt-5',
    // نماذج التفكير تحتاج حد أعلى لأن التفكير الداخلي يُحسب منه
    max_completion_tokens: maxTokens * 4,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content },
    ],
  };
  if (process.env.OPENAI_REASONING_EFFORT) payload.reasoning_effort = process.env.OPENAI_REASONING_EFFORT;
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const data = await readUpstream(r, 'ChatGPT');
  const text = String(data.choices?.[0]?.message?.content || '').trim();
  if (!text) throw new Error('ChatGPT: رد فاضي (جرّب تضبط OPENAI_REASONING_EFFORT على low)');
  return text;
}

// ---------------- Gemini ----------------
async function askGemini({ system, prompt, attachments, maxTokens }) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('GEMINI_API_KEY غير مضبوط');
  const model = process.env.GEMINI_MODEL || 'gemini-flash-latest';
  const parts = attachments.map((a) => ({ inlineData: { mimeType: a.mime, data: a.data } }));
  parts.push({ text: prompt });
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: maxTokens * 4 },
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    },
  );
  const data = await readUpstream(r, 'Gemini');
  const cand = data.candidates?.[0];
  const text = (cand?.content?.parts || []).filter((p) => !p.thought && p.text).map((p) => p.text).join('\n').trim();
  if (!text) {
    const why = data.promptFeedback?.blockReason || cand?.finishReason || 'رد فاضي';
    throw new Error(`Gemini: ${why}`);
  }
  return text;
}

const HANDLERS = { claude: askClaude, openai: askOpenAI, gemini: askGemini };

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const { model, system = '', prompt = '', attachments, maxTokens } = body(req);
  const fn = HANDLERS[model];
  if (!fn) return res.status(400).json({ error: 'نموذج غير معروف' });
  if (!String(prompt).trim()) return res.status(400).json({ error: 'الطلب فاضي' });
  try {
    const text = await fn({
      system: String(system),
      prompt: String(prompt),
      attachments: cleanAttachments(attachments),
      maxTokens: clampTokens(maxTokens, 1500),
    });
    return res.status(200).json({ text });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const status = timedOut ? 504 : (e.status && e.status >= 400 && e.status < 600 ? e.status : 502);
    return res.status(status).json({ error: timedOut ? 'انتهت المهلة قبل ما يرد النموذج' : e.message });
  }
}
