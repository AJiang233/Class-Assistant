import { canView, loadViewer } from '../utils/audience.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { pageLimit } from '../utils/query.js';

/**
 * @typedef {{seq:number,kind:'notices'|'activities'|'forms',id:number,deleted:boolean,
 * operation?:string,row?:Object}} SyncChange
 * @typedef {{version:1,rules:string,until:number,cursor:number,hasMore:boolean,changes:SyncChange[]}} SyncPage
 */

function sequence(value, fallback = 0) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}

/** 固定上界中的历史快照由变更记录保存，翻页期间的新写入留给下一轮。 */
export async function handleSync(request, env, user) {
  const url = new URL(request.url);
  const after = sequence(url.searchParams.get('after'));
  const requestedUntil = sequence(url.searchParams.get('until'));
  if (after === null || requestedUntil === null) return jsonResponse(error('同步游标格式不正确', 'INVALID_CURSOR'), 400);
  const viewer = await loadViewer(env, user);
  const ruleText = JSON.stringify([1, user.id, user.positions, viewer.roleMap]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ruleText));
  const rules = Array.from(new Uint8Array(digest), (x) => x.toString(16).padStart(2, '0')).join('');
  const previousRules = url.searchParams.get('rules');
  if ((previousRules && previousRules !== rules) || (after > 0 && !previousRules)) {
    return jsonResponse(success({ reset: true, rules, version: 1 }));
  }
  const max = await env.DB.prepare('SELECT coalesce(max(seq),0) AS seq FROM content_changes').first();
  const until = url.searchParams.has('until') ? requestedUntil : max.seq;
  if (until > max.seq || after > until) return jsonResponse(error('同步游标超出有效范围', 'INVALID_CURSOR'), 400);
  const limit = pageLimit(url, 100);
  // 初始化只回放固定上界中各条目的最后版本，避免新安装逐条下载全部编辑历史。
  const snapshot = url.searchParams.get('snapshot') === '1';
  const latest = snapshot ? `AND NOT EXISTS (SELECT 1 FROM content_changes newer
    WHERE newer.kind=c.kind AND newer.item_id=c.item_id AND newer.seq>c.seq AND newer.seq<=?)` : '';
  const { results } = await env.DB.prepare(`SELECT seq,kind,item_id,operation,payload FROM content_changes c
    WHERE seq>? AND seq<=? ${latest} ORDER BY seq LIMIT ?`)
    .bind(after, until, ...(snapshot ? [until] : []), limit + 1).all();
  const rows = results.slice(0, limit);
  const changes = rows.map((change) => {
    const row = JSON.parse(change.payload);
    const base = { seq: change.seq, kind: change.kind, id: change.item_id };
    if (change.operation === 'delete' || !canView(row.remind_people, viewer)) return { ...base, deleted: true };
    const { remind_people, fields, submitted_users, ...visible } = row;
    if (change.kind === 'forms') {
      visible.submitted = (submitted_users || []).includes(Number(user.id));
    }
    return { ...base, deleted: false, operation: change.operation, row: visible };
  });
  const hasMore = results.length > limit;
  return jsonResponse(success({ version: 1, rules, until,
    cursor: hasMore ? rows.at(-1).seq : until, hasMore, changes }));
}
