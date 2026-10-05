/** 提醒名单的写入契约：空数组为全班；非空数组只接受现存用户 ID。 */
export async function normalizeRecipients(db, raw) {
  if (raw == null || raw === '') return null;
  let list = raw;
  if (typeof raw === 'string') {
    try { list = JSON.parse(raw); } catch { return false; }
  }
  if (!Array.isArray(list)) return false;
  if (list.some((id) => typeof id !== 'number' && !(typeof id === 'string' && /^\d+$/.test(id)))) return false;
  const ids = [...new Set(list.map((id) => Number(id)))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) return false;
  if (!ids.length) return null;
  const { results } = await db.prepare('SELECT id FROM users').all();
  const existing = new Set(results.map((row) => Number(row.id)));
  if (ids.some((id) => !existing.has(id))) return false;
  return JSON.stringify(ids.sort((a, b) => a - b));
}

/** 个人查询必须在 LIMIT 之前应用；列名只由内部调用方提供。 */
export function recipientPredicate(column = 'remind_people') {
  return `(((${column} IS NULL OR ${column} = '' OR ${column} = '[]') AND ? = 0)
    OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(${column}) THEN ${column} ELSE '[]' END)
      WHERE CAST(value AS TEXT) = ?))`;
}
