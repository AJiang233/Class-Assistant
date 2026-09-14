import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { resolveCurrentTermId, termIdByDate } from '../src/handlers/academicHandler.js';

/** 北京时间某日零点（用 UTC 表示），免得测试跟着跑测试机器的时区走 */
function bjDate(text) {
  return new Date(text + 'T00:00:00+08:00');
}

/**
 * 「现在该看哪一学期」。
 *
 * 为什么盯这个：教务的学期列表是按时间倒序给的，而它自己的「当前学期」标记会在学期切换前
 * 就把下一学期标上 —— 2026-2027-2 还没开学就已经成了默认项，用户每次进「学业」看到的都是
 * 一份还没开始的课表。所以默认学期改成按日期从学期 id 推，这里把划分钉住。
 */
describe('按日期推断当前学期', () => {
  it('9 月到次年 1 月是第 1 学期', () => {
    assert.equal(termIdByDate(bjDate('2026-09-14')), '2026-2027-1');
    assert.equal(termIdByDate(bjDate('2027-01-10')), '2026-2027-1');
  });

  it('2 月到 8 月是第 2 学期（暑假算上学年末尾）', () => {
    assert.equal(termIdByDate(bjDate('2027-03-05')), '2026-2027-2');
    assert.equal(termIdByDate(bjDate('2027-08-20')), '2026-2027-2');
  });

  it('按北京时间算：UTC 还是 8 月 31 日时，北京时间已经是 9 月 1 日', () => {
    // Workers 跑在 UTC，这一天的边界会差出新旧学年，不能按 UTC 取月份
    assert.equal(termIdByDate(new Date('2026-08-31T17:30:00Z')), '2026-2027-1');
  });
});

/**
 * 看哪一学期。第一组是这次要修的现场：教务把还没开学的 2026-2027-2 标成了当前学期，
 * 而学期列表倒序第一项也是它 —— 两条老路都会走到那份还没开始的课表上去。
 */
describe('默认学期怎么挑', () => {
  const now = bjDate('2026-09-14');

  it('教务把未来的学期标成「当前」也不认，按日期取当前学期', () => {
    const live = [
      { id: '2026-2027-2', dqxqflag: '1' },
      { id: '2026-2027-1', dqxqflag: '0' },
      { id: '2025-2026-2', dqxqflag: '0' }
    ];
    assert.equal(resolveCurrentTermId(live, [], '', now), '2026-2027-1');
  });

  it('标记的写法不一定是字符串 1（可能是数字或布尔）', () => {
    const live = [{ id: '2026-2027-2', dqxqflag: true }];
    // 列表里没有按日期推出来的 2026-2027-1：这时才轮到教务标记，认得出它就不会错拿第一项
    assert.equal(resolveCurrentTermId(live, [], '', now), '2026-2027-2');
  });

  it('按日期推出来的学期不在教务列表里，用教务标的那一项', () => {
    const live = [
      { id: '2027-2028-1', dqxqflag: '0' },
      { id: '2026-2027-2', dqxqflag: '1' }
    ];
    assert.equal(resolveCurrentTermId(live, [], '', now), '2026-2027-2');
  });

  it('教务不可达（列表为空）时看缓存里有哪些学期', () => {
    const cached = [{ xnxq_id: '2026-2027-2' }, { xnxq_id: '2026-2027-1' }];
    assert.equal(resolveCurrentTermId(null, cached, '', now), '2026-2027-1');
    // 缓存里也没有当前学期：只能取缓存的第一个，至少不要报「取不到学期」
    assert.equal(resolveCurrentTermId(null, [{ xnxq_id: '2026-2027-2' }], '', now), '2026-2027-2');
  });

  it('两边都空：返回空串，交给调用方报错，不要瞎猜一个学期', () => {
    assert.equal(resolveCurrentTermId(null, null, '', now), '');
    assert.equal(resolveCurrentTermId([], [], '', now), '');
  });
});

/**
 * 指定了学期（下拉里选的、或前端带回上次看的那一个）。
 * 关键是把「选了个教务不认的旧学期」和「教务正好连不上」分开：前者要回落，
 * 后者不能把人选的学期丢掉 —— 缓存里还存着那个学期的课表。
 */
describe('指定学期时', () => {
  const now = bjDate('2026-09-14');
  const live = [{ id: '2026-2027-1' }, { id: '2025-2026-2' }];

  it('教务列表里有这个学期，就用它（哪怕不是当前学期）', () => {
    assert.equal(resolveCurrentTermId(live, [], '2025-2026-2', now), '2025-2026-2');
  });

  it('列表里已经没这个学期了：回落到当前学期，不去抓一份空课表', () => {
    assert.equal(resolveCurrentTermId(live, [], '2019-2020-1', now), '2026-2027-1');
  });

  it('教务连不上（列表为空）：仍然用指定的学期，缓存里也许还留着它', () => {
    assert.equal(resolveCurrentTermId(null, [{ xnxq_id: '2025-2026-2' }], '2025-2026-2', now), '2025-2026-2');
  });
});
