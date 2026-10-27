import { guard, body, cleanAttachments } from '../lib/common.js';

const BASE = 'https://api.manus.ai';

async function manus(path, { method = 'GET', payload } = {}) {
  const key = process.env.MANUS_API_KEY;
  if (!key) throw new Error('MANUS_API_KEY غير مضبوط');
  const r = await fetch(BASE + path, {
    method,
    headers: { 'x-manus-api-key': key, 'content-type': 'application/json' },
    body: payload ? JSON.stringify(payload) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  let data = null;
  try { data = await r.json(); } catch { /* ignore */ }
  if (!r.ok || data?.ok === false) {
    const err = new Error(`Manus: ${data?.error?.message || `HTTP ${r.status}`}`);
    err.status = r.status;
    throw err;
  }
  return data;
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');

/**
 * نص المستخدم في Manus محدود (~5000 توكن) لكن الملفات ما تُحسب،
 * فنرسل الموضوع والتعليمات كاملة داخل ملف نصي ونخلي الرسالة قصيرة.
 */
async function start({ system, prompt, attachments }) {
  const doc = `# تعليمات المشاركة\n\n${system}\n\n---\n\n# المطلوب الآن\n\n${prompt}\n`;
  const parts = [
    {
      type: 'text',
      text:
        'اقرأ الملف المرفق roundtable.md ونفّذ المطلوب فيه. ' +
        'جاوب مباشرة في رسالة نصية واحدة بدون ما تنشئ ملفات أو مواقع أو عروض.',
    },
    {
      type: 'file',
      file_data: `data:text/markdown;base64,${b64(doc)}`,
      filename: 'roundtable.md',
      mime_type: 'text/markdown',
    },
  ];
  for (const a of attachments) {
    parts.push({ type: 'file', file_data: `data:${a.mime};base64,${a.data}`, filename: a.name, mime_type: a.mime });
  }
  const payload = {
    message: { content: parts },
    title: 'Roundtable',
    hide_in_task_list: true,
    interactive_mode: false,
    agent_profile: process.env.MANUS_PROFILE || 'standard',
  };
  const j = await manus('/v2/task.create', { method: 'POST', payload });
  if (!j.task_id) throw new Error('Manus: ما رجع task_id');
  return { taskId: j.task_id };
}

async function poll({ taskId, nudge }) {
  if (!/^[A-Za-z0-9_-]{6,64}$/.test(String(taskId || ''))) throw new Error('taskId غير صالح');

  if (nudge) {
    await manus('/v2/task.sendMessage', {
      method: 'POST',
      payload: {
        task_id: taskId,
        message: { content: 'تابع واستخدم أفضل تقدير عندك بدون أسئلة، وجاوب في رسالة نصية مباشرة.' },
      },
    });
    return { status: 'running' };
  }

  const j = await manus(`/v2/task.listMessages?task_id=${encodeURIComponent(taskId)}&order=desc&limit=50`);
  const msgs = Array.isArray(j.messages) ? j.messages : [];
  // الأحدث أول (order=desc)
  const st = msgs.find((m) => m.type === 'status_update');
  const status = st?.status_update?.agent_status || 'running';

  if (status === 'stopped') {
    const answers = msgs.filter((m) => m.type === 'assistant_message' && m.assistant_message?.content);
    const pick = answers.find((m) => m.assistant_message.delivery_kind === 'result') || answers[0];
    if (!pick) return { status: 'error', text: 'Manus وقف بدون رد' };
    return { status: 'done', text: String(pick.assistant_message.content).trim() };
  }
  if (status === 'error') {
    const em = msgs.find((m) => m.type === 'error_message');
    return { status: 'error', text: em?.error_message?.content || 'Manus رجّع خطأ' };
  }
  if (status === 'waiting') {
    return { status: 'waiting', detail: st?.status_update?.status_detail?.waiting_description || '' };
  }
  return { status: 'running' };
}

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const b = body(req);
  try {
    if (b.action === 'start') {
      if (!String(b.prompt || '').trim()) return res.status(400).json({ error: 'الطلب فاضي' });
      const out = await start({
        system: String(b.system || ''),
        prompt: String(b.prompt),
        attachments: cleanAttachments(b.attachments),
      });
      return res.status(200).json(out);
    }
    if (b.action === 'poll') {
      const out = await poll({ taskId: b.taskId, nudge: !!b.nudge });
      return res.status(200).json(out);
    }
    return res.status(400).json({ error: 'action غير معروف' });
  } catch (e) {
    const timedOut = e?.name === 'TimeoutError' || e?.name === 'AbortError';
    const status = timedOut ? 504 : (e.status && e.status >= 400 && e.status < 600 ? e.status : 502);
    return res.status(status).json({ error: timedOut ? 'انتهت المهلة مع Manus' : e.message });
  }
}
