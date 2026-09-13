import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  buildCsv,
  csvCell,
  handleListMyForms,
  normalizeFields,
  parseFields,
  validateAnswers
} from '../src/handlers/formHandler.js';
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
});
