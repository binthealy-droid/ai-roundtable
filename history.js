import { guard, body, getSql } from '../lib/common.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLES = new Set(['user', 'claude', 'openai', 'gemini', 'manus', 'summary']);

export default async function handler(req, res) {
  if (!guard(req, res)) return;
  const b = body(req);
  try {
    if (b.action === 'ping') return res.status(200).json({ ok: true });

    const sql = await getSql();

    if (b.action === 'list') {
      const rows = await sql`SELECT id, title, created_at FROM rt_chats ORDER BY created_at DESC LIMIT 100`;
      return res.status(200).json({ chats: rows });
    }

    if (b.action === 'create') {
      const title = String(b.title || 'موضوع بدون عنوان').trim().slice(0, 120) || 'موضوع بدون عنوان';
      const rows = await sql`INSERT INTO rt_chats (title) VALUES (${title}) RETURNING id`;
      return res.status(200).json({ id: rows[0].id });
    }

    if (b.action === 'add') {
      if (!UUID.test(String(b.chatId || ''))) return res.status(400).json({ error: 'chatId غير صالح' });
      if (!ROLES.has(b.role)) return res.status(400).json({ error: 'role غير صالح' });
      const round = Math.max(0, Math.min(Number(b.round) || 0, 20));
      const content = String(b.content || '').slice(0, 60000);
      if (!content) return res.status(400).json({ error: 'المحتوى فاضي' });
      const meta = JSON.stringify(b.meta && typeof b.meta === 'object' ? b.meta : {});
      await sql`INSERT INTO rt_messages (chat_id, role, round, content, meta)
                VALUES (${b.chatId}, ${b.role}, ${round}, ${content}, ${meta}::jsonb)`;
      return res.status(200).json({ ok: true });
    }

    if (b.action === 'get') {
      if (!UUID.test(String(b.chatId || ''))) return res.status(400).json({ error: 'chatId غير صالح' });
      const chat = await sql`SELECT id, title, created_at FROM rt_chats WHERE id = ${b.chatId}`;
      if (!chat.length) return res.status(404).json({ error: 'المحادثة غير موجودة' });
      const messages = await sql`SELECT role, round, content, meta FROM rt_messages WHERE chat_id = ${b.chatId} ORDER BY id`;
      return res.status(200).json({ chat: chat[0], messages });
    }

    if (b.action === 'delete') {
      if (!UUID.test(String(b.chatId || ''))) return res.status(400).json({ error: 'chatId غير صالح' });
      await sql`DELETE FROM rt_chats WHERE id = ${b.chatId}`;
      return res.status(200).json({ ok: true });
    }

    return res.status(400).json({ error: 'action غير معروف' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
