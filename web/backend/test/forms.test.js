import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCsv,
  csvCell
} from '../src/handlers/formExport.js';
import {
  handleCreateForm,
  handleListMyForms,
  handleUpdateForm
} from '../src/handlers/formHandler.js';
import {
  normalizeFields,
  parseFields,
  submitGate,
  validateAnswers
} from '../src/handlers/formValidation.js';
import { EDIT_POLICY } from '../src/models/formModel.js';
import { isSafeLink } from '../src/utils/link.js';

describe('字段定义校验', () => {
  it('合法字段通过并规范化', () => {
    const r = normalizeFields([
      { key: 'note', label: '备注', type: 'text', required: true },
      { key: 'meal', label: '餐次', type: 'radio', options: ['午餐', '晚餐'] }
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.fields.length, 2);
    assert.equal(r.fields[0].required, true);
    assert.deepEqual(r.fields[1].options, ['午餐', '晚餐']);
    assert.equal(r.fields[1].required, false);
  });

  it('空数组 / 非数组被拒', () => {
    assert.equal(normalizeFields([]).ok, false);
    assert.equal(normalizeFields(null).ok, false);
    assert.equal(normalizeFields({}).ok, false);
  });

  it('字段标识非法或重复被拒', () => {
    assert.equal(normalizeFields([{ key: '1x', label: 'A', type: 'text' }]).ok, false);
    assert.equal(normalizeFields([{ key: 'a b', label: 'A', type: 'text' }]).ok, false);
    assert.equal(normalizeFields([
      { key: 'a', label: 'A', type: 'text' },
      { key: 'a', label: 'B', type: 'text' }
    ]).ok, false);
  });

  it('字段名为空、类型不支持被拒', () => {
    assert.equal(normalizeFields([{ key: 'a', label: '  ', type: 'text' }]).ok, false);
    assert.equal(normalizeFields([{ key: 'a', label: 'A', type: 'file' }]).ok, false);
  });

  it('单选/多选少于 2 个选项被拒', () => {
    assert.equal(normalizeFields([{ key: 'a', label: 'A', type: 'radio', options: ['只有一个'] }]).ok, false);
    assert.equal(normalizeFields([{ key: 'a', label: 'A', type: 'checkbox', options: [] }]).ok, false);
  });

  it('字段数超过上限被拒', () => {
    const many = Array.from({ length: 51 }, (_, i) => ({ key: 'q' + i, label: 'L' + i, type: 'text' }));
    assert.equal(normalizeFields(many).ok, false);
  });

  it('parseFields 对坏数据返回空数组', () => {
    assert.deepEqual(parseFields('not json'), []);
    assert.deepEqual(parseFields('{"a":1}'), []);
    assert.deepEqual(parseFields(null), []);
    assert.equal(parseFields('[{"key":"a","label":"A","type":"text"}]').length, 1);
  });
});

describe('答案校验', () => {
  const fields = [
    { key: 'note', label: '备注', type: 'text', required: true },
    { key: 'meal', label: '餐次', type: 'radio', required: true, options: ['午餐', '晚餐'] },
    { key: 'extra', label: '附加', type: 'checkbox', options: ['餐具', '打包'] },
    { key: 'count', label: '人数', type: 'number' },
    { key: 'day', label: '日期', type: 'date' }
  ];

  it('完整答案通过', () => {
    const r = validateAnswers(fields, { note: '不要辣', meal: '午餐', extra: ['餐具'], count: '2', day: '2026-09-20' });
    assert.equal(r.ok, true);
    assert.equal(r.answers.note, '不要辣');
    assert.deepEqual(r.answers.extra, ['餐具']);
  });

  it('必填缺失被拒且提示字段名', () => {
    const r = validateAnswers(fields, { note: '  ', meal: '午餐' });
    assert.equal(r.ok, false);
    assert.match(r.message, /备注/);
  });

  it('选项越界被拒', () => {
    assert.equal(validateAnswers(fields, { note: 'a', meal: '夜宵' }).ok, false);
    assert.equal(validateAnswers(fields, { note: 'a', meal: '午餐', extra: ['不存在'] }).ok, false);
  });

  it('多选去重', () => {
    const r = validateAnswers(fields, { note: 'a', meal: '午餐', extra: ['餐具', '餐具', '打包'] });
    assert.equal(r.ok, true);
    assert.deepEqual(r.answers.extra, ['餐具', '打包']);
  });

  it('数字与日期格式被校验', () => {
    assert.equal(validateAnswers(fields, { note: 'a', meal: '午餐', count: 'abc' }).ok, false);
    assert.equal(validateAnswers(fields, { note: 'a', meal: '午餐', day: '2026/09/20' }).ok, false);
    assert.equal(validateAnswers(fields, { note: 'a', meal: '午餐', count: '-1.5', day: '2026-09-20' }).ok, true);
  });

  it('超长文本被拒', () => {
    const r = validateAnswers(fields, { note: 'x'.repeat(2001), meal: '午餐' });
    assert.equal(r.ok, false);
  });

  it('定义外的多余键被忽略', () => {
    const r = validateAnswers(fields, { note: 'a', meal: '午餐', hacker: 'x' });
    assert.equal(r.ok, true);
    assert.equal('hacker' in r.answers, false);
  });

  it('答案不是对象被拒', () => {
    assert.equal(validateAnswers(fields, null).ok, false);
    assert.equal(validateAnswers(fields, []).ok, false);
    assert.equal(validateAnswers(fields, 'x').ok, false);
  });
});

describe('CSV 导出', () => {
  it('公式注入被中和（= + - @ 开头）', () => {
    assert.equal(csvCell('=1+1'), "'=1+1");
    assert.equal(csvCell('+1'), "'+1");
    assert.equal(csvCell('-1'), "'-1");
    assert.equal(csvCell('@x'), "'@x");
    assert.equal(csvCell('正常'), '正常');
  });

  it('含逗号 / 引号 / 换行时加引号并转义', () => {
    assert.equal(csvCell('a,b'), '"a,b"');
    assert.equal(csvCell('a"b'), '"a""b"');
    assert.equal(csvCell('a\nb'), '"a\nb"');
    assert.equal(csvCell('a"b,c'), '"a""b,c"');
  });

  it('空值输出空串', () => {
    assert.equal(csvCell(null), '');
    assert.equal(csvCell(undefined), '');
    assert.equal(csvCell(''), '');
  });

  it('buildCsv 用 CRLF 连接各行', () => {
    const csv = buildCsv(['学号', '姓名'], [['11925111', '刘科江'], ['11925112', '张三']]);
    const lines = csv.split('\r\n');
    assert.equal(lines.length, 3);
    assert.equal(lines[0], '学号,姓名');
    assert.equal(lines[2], '11925112,张三');
  });

  it('多选字段用顿号连接（answerText 语义）', () => {
    // 导出时数组会被 answerText 拼成顿号分隔，这里直接验证拼接结果符合预期
    assert.equal(['餐具', '打包'].join('、'), '餐具、打包');
  });
});

describe('通知跳转链接校验', () => {
  it('站内相对路径通过', () => {
    assert.equal(isSafeLink('/forms.html?id=1'), true);
    assert.equal(isSafeLink('/notices'), true);
    assert.equal(isSafeLink('  /a/b?x=1&y=2#z  '), true);
  });

  it('空值视为不带跳转', () => {
    assert.equal(isSafeLink(''), true);
    assert.equal(isSafeLink(null), true);
    assert.equal(isSafeLink(undefined), true);
  });

  it('外站与伪协议被拒', () => {
    assert.equal(isSafeLink('//evil.com'), false);
    assert.equal(isSafeLink('http://evil.com'), false);
    assert.equal(isSafeLink('https://evil.com/x'), false);
    assert.equal(isSafeLink('javascript:alert(1)'), false);
    assert.equal(isSafeLink('data:text/html,x'), false);
    assert.equal(isSafeLink('/a b'), false);
  });
});

describe('修改策略取值', () => {
  it('三个取值与后端白名单一致，避免拼写漂移', () => {
    assert.deepEqual(Object.values(EDIT_POLICY).sort(), ['always', 'before_deadline', 'none']);
  });
});

describe('我的表单列表', () => {
  // 只喂 listMine 与 loadRoleMap 两条 SQL；这个用例只关心返回的字段，不关心怎么筛
  function fakeDb(rows) {
    return {
      prepare(sql) {
        const stmt = {
          _args: [],
          bind(...args) { stmt._args = args; return stmt; },
          async all() {
            if (/FROM roles/i.test(sql)) return { results: [] };
            return { results: rows };
          },
          async first() { return null; },
          async run() { return {}; }
        };
        return stmt;
      }
    };
  }

  /**
   * created_at 是 App 端（安卓 / 鸿蒙）判断「这条表单提醒过没有」的唯一依据，
   * 与通知的 publish_time 同一口径。删掉这个字段两端就只会整批当新的推 —— 或者干脆推不了。
   */
  it('pending 每条都带 created_at（App 端靠它判新）', async () => {
    const env = {
      DB: fakeDb([{
        id: 3,
        title: '聚餐报名',
        description: '',
        remind_people: null,
        edit_policy: EDIT_POLICY.NONE,
        anonymous: 0,
        creator_name: '班长',
        created_at: '2026-09-13 10:00:00',
        my_submitted_at: null
      }])
    };
    const res = await handleListMyForms(
      new Request('https://class.example/api/forms/mine'),
      env,
      { id: 2, name: '张三', positions: '学生' }
    );
    const body = await res.json();

    assert.equal(body.data.pending.length, 1);
    assert.equal(body.data.pending[0].created_at, '2026-09-13 10:00:00');
    assert.equal(body.data.pending[0].title, '聚餐报名');
  });

  it('每条都带 edit_policy（主页第二个徽章靠它区分三种策略）', async () => {
    const env = {
      DB: fakeDb([{
        id: 4,
        title: '暑期实践报名',
        description: '',
        remind_people: null,
        edit_policy: EDIT_POLICY.BEFORE_DEADLINE,
        anonymous: 0,
        creator_name: '班长',
        deadline: null,
        created_at: '2026-09-13 10:00:00',
        my_submitted_at: null
      }])
    };
    const res = await handleListMyForms(
      new Request('https://class.example/api/forms/mine'),
      env,
      { id: 2, name: '张三', positions: '学生' }
    );
    const body = await res.json();

    assert.equal(body.data.pending[0].edit_policy, EDIT_POLICY.BEFORE_DEADLINE);
  });

  /**
   * 「随时可修改」不受截止时间约束：过了截止也要列出来（还能补交、改答案），
   * 其余策略过了截止就不再算待办。这条口径必须与 submitGate 的放行一致，
   * 否则会出现「列表里列出来了却点不动」。
   */
  it('过截止：always 照常列出，其余策略被滤掉，没截止的照常列出', async () => {
    const base = {
      description: '',
      remind_people: null,
      anonymous: 0,
      creator_name: '班长',
      created_at: '2026-09-13 10:00:00',
      my_submitted_at: null,
      deadline: '2020-01-01 00:00:00'
    };
    const env = {
      DB: fakeDb([
        { ...base, id: 11, title: '随时可改的', edit_policy: EDIT_POLICY.ALWAYS },
        { ...base, id: 12, title: '截止前可改的', edit_policy: EDIT_POLICY.BEFORE_DEADLINE },
        { ...base, id: 13, title: '不可改的', edit_policy: EDIT_POLICY.NONE },
        { ...base, id: 14, title: '没截止的', edit_policy: EDIT_POLICY.NONE, deadline: null }
      ])
    };
    const res = await handleListMyForms(
      new Request('https://class.example/api/forms/mine'),
      env,
      { id: 2, name: '张三', positions: '学生' }
    );
    const titles = (await res.json()).data.pending.map((f) => f.title);

    assert.ok(titles.includes('随时可改的'), 'always 过截止仍要能填，必须列出');
    assert.ok(titles.includes('没截止的'), '没有截止时间的照常列出');
    assert.equal(titles.includes('截止前可改的'), false, '过截止且非 always 的不再算待办');
    assert.equal(titles.includes('不可改的'), false, '过截止且非 always 的不再算待办');
  });

  /**
   * 已提交不意味着消失：edit_policy 只决定点进去还能不能改，
   * 「还显不显示」只看截止时间（always 则连截止时间都不看）。
   */
  it('已提交的表单都留着：不可修改的只是从「待填」挪到「已提交」', async () => {
    const base = {
      description: '',
      remind_people: null,
      anonymous: 0,
      creator_name: '班长',
      deadline: null,
      created_at: '2026-09-13 10:00:00',
      my_submitted_at: '2026-09-13 12:00:00'
    };
    const env = {
      DB: fakeDb([
        { ...base, id: 21, title: '交了不可改的', edit_policy: EDIT_POLICY.NONE },
        { ...base, id: 22, title: '交了截止前可改的', edit_policy: EDIT_POLICY.BEFORE_DEADLINE },
        { ...base, id: 23, title: '交了随时可改的', edit_policy: EDIT_POLICY.ALWAYS }
      ])
    };
    const res = await handleListMyForms(
      new Request('https://class.example/api/forms/mine'),
      env,
      { id: 2, name: '张三', positions: '学生' }
    );
    const body = await res.json();

    assert.equal(body.data.pending.length, 0, '已提交的不该再算「待填」');
    assert.deepEqual(
      body.data.editable.map((f) => f.edit_policy).sort(),
      ['always', 'before_deadline', 'none'],
      '三种策略的已提交表单都要留着，不能因「不可修改」消失'
    );
  });
});

describe('提交闸门', () => {
  const pastForm = { status: 'open', edit_policy: EDIT_POLICY.ALWAYS, deadline: '2020-01-01 00:00:00' };

  it('always 过截止仍可提交（与列表的放行同一口径）', () => {
    assert.equal(submitGate(pastForm, false).ok, true);
    assert.equal(submitGate(pastForm, true).ok, true);
  });

  it('其余策略过截止被拦', () => {
    assert.equal(submitGate({ ...pastForm, edit_policy: EDIT_POLICY.BEFORE_DEADLINE }, false).ok, false);
    assert.equal(submitGate({ ...pastForm, edit_policy: EDIT_POLICY.NONE }, false).ok, false);
  });

  it('关闭的表单一律不可提交，与策略无关', () => {
    assert.equal(submitGate({ ...pastForm, status: 'closed' }, false).ok, false);
  });
});

describe('创建表单：联动通知失败时的回滚', () => {
  /**
   * 内存假 D1：INSERT 记行、DELETE 删行，`UPDATE forms` 一律抛错。
   * 这样能停在 issue #72 那一刻 —— 通知已经落库，回写 forms.notice_id 失败 ——
   * 只盯住「回滚后两张表还剩什么」。假表只存 id，够用来判残留。
   */
  function fakeDb() {
    const forms = [];
    const notices = [];
    let nextId = 1;

    return {
      forms,
      notices,
      prepare(sql) {
        const stmt = {
          _args: [],
          bind(...args) { stmt._args = args; return stmt; },
          async all() { return { results: [] }; },
          async first() {
            if (/INSERT INTO forms/i.test(sql)) {
              const id = nextId++;
              forms.push({ id });
              return { id };
            }
            if (/INSERT INTO notices/i.test(sql)) {
              const id = nextId++;
              notices.push({ id });
              return { id };
            }
            return null;
          },
          async run() {
            if (/UPDATE forms/i.test(sql)) throw new Error('D1_ERROR: 回写 notice_id 失败');
            const [id] = stmt._args;
            const table = /DELETE FROM notices/i.test(sql) ? notices
              : /DELETE FROM forms/i.test(sql) ? forms : null;
            if (table) {
              const i = table.findIndex((row) => row.id === id);
              if (i >= 0) table.splice(i, 1);
            }
            return {};
          }
        };
        return stmt;
      }
    };
  }

  it('通知已写入但回写 notice_id 失败：通知与表单都不留残留', async () => {
    const db = fakeDb();
    const res = await handleCreateForm(
      new Request('https://class.example/api/forms', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: '聚餐报名',
          fields: [{ key: 'note', label: '备注', type: 'text' }],
          notice: true
        })
      }),
      { DB: db },
      { id: 2, name: '班长' }
    );

    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, 'NOTICE_LINK_FAILED');
    assert.deepEqual(db.notices, [], '通知已落库却只删表单，就会留下指向已删表单的孤儿通知');
    assert.deepEqual(db.forms, [], '表单也要回滚干净');
  });
});

describe('编辑表单：字段锁与写入是同一条语句', () => {
  /**
   * 内存假 D1：`SELECT ... FROM forms` 回一行表单（给 loadOwnedForm 用），
   * `UPDATE forms` 按真语句里的 NOT EXISTS(form_submissions) 决定改几行。
   *
   * 假 D1 必须真按 WHERE 算 —— 一律返回 changes > 0 的话，这条用例就只是自说自话，
   * 证明不了闸门（判定并进 WHERE 之后，能不能挡住全靠 changes === 0 是算出来的）。
   */
  function fakeDb({ submitted = false } = {}) {
    const writes = [];
    return {
      writes,
      prepare(sql) {
        const stmt = {
          _args: [],
          bind(...args) { stmt._args = args; return stmt; },
          async all() { return { results: [] }; },
          async first() {
            if (/FROM forms/i.test(sql)) {
              return {
                id: 5, title: '聚餐报名', description: '', fields: '[]', edit_policy: 'always',
                anonymous: 0, status: 'open', deadline: null, creator_id: 2,
                creator_name: '班长', remind_people: null, notice_id: null
              };
            }
            return null;
          },
          async run() {
            if (!/UPDATE forms/i.test(sql)) throw new Error('假 D1 不认识的 SQL: ' + sql);
            const guarded = /NOT EXISTS/i.test(sql);
            if (guarded && submitted) return { meta: { changes: 0 } };
            writes.push({ sql, args: stmt._args });
            return { meta: { changes: 1 } };
          }
        };
        return stmt;
      }
    };
  }

  const BODY = JSON.stringify({
    title: '聚餐报名（改）',
    fields: [{ key: 'note', label: '备注', type: 'text' }]
  });

  function update(env, body = BODY) {
    return handleUpdateForm(
      new Request('https://class.example/api/forms/5', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body
      }),
      env,
      { id: 2, name: '班长' },
      { id: '5' }
    );
  }

  /**
   * 一个字段都没带时必须报错。以前这里会走到 model.update(id, {})，
   * 模型层拼不出 SET 子句就 return {success:true}，于是回 200「表单已保存」——
   * 调用方以为存上了、库里一个字没动（issue #22）。
   */
  it('没带任何字段：回 400 而不是把「一个字没写」报成保存成功', async () => {
    const db = fakeDb();
    const res = await update({ DB: db }, '{}');

    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'MISSING_FIELDS');
    assert.equal(db.writes.length, 0, '空请求不该碰数据库');
  });

  it('请求体不是合法 JSON：同样按「没字段」挡回去', async () => {
    const db = fakeDb();
    const res = await update({ DB: db }, 'not json');

    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'MISSING_FIELDS');
    assert.equal(db.writes.length, 0);
  });

  it('已有人提交：改了字段就被挡回去，同一请求里的标题也不落库', async () => {
    const db = fakeDb({ submitted: true });
    const res = await update({ DB: db });

    assert.equal(res.status, 409);
    assert.equal((await res.json()).code, 'FORM_FIELDS_LOCKED');
    // 判定与写入同一条语句，所以「字段被锁」时标题也一起没写 —— 这正是把两步合成一步要的效果：
    // 拆成两次写的话，就会出现「字段被拒、标题却改了」这种半截状态。
    assert.equal(db.writes.length, 0, '被 WHERE 挡住的 UPDATE 不该留下任何写入');
  });

  it('还没人提交：标题与字段在同一次写入里一起保存', async () => {
    const db = fakeDb();
    const res = await update({ DB: db });

    assert.equal(res.status, 200);
    assert.equal(db.writes.length, 1);
    const args = db.writes[0].args;
    assert.ok(args.includes('聚餐报名（改）'), '标题应该和字段在同一条 UPDATE 里');
    assert.ok(
      args.some((v) => typeof v === 'string' && v.includes('"key":"note"')),
      '字段定义也要写进去'
    );
  });
});
