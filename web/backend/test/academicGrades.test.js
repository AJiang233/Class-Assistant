import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ALL_TERM_ID,
  buildGradeTerms,
  courseCodeOf,
  courseNameOf,
  isCountedForStats,
  normalizeGradeItem,
  normalizeGrades
} from '../src/handlers/academicHandler.js';

/**
 * 成绩的解析与汇总口径（issue #38）。
 *
 * 这里钉的每一条都对应野外数据里真实出现过的形状，不是提前防御 —— 教务返回的成绩列
 * 远不止「一个数字」：缓考时成绩位写 0、等级制课程写「合格」「A」、还有两门课被教务
 * 自己标了「不参与所有成绩统计计算」。照单全收的话均分会明显偏低，而界面上看不出
 * 任何异常（数字就是小了几分的数字），所以把这些形状与排除规则一起钉住。
 */

/** 只给测试用的最小成绩行；真实字段名见 schoolApi.gradeList 的注释 */
function raw(over) {
  return {
    kcxx: '',
    xf: 0,
    zcj: '',
    jd: '',
    cjxzmc: '正常考试',
    cjbzmc: '',
    cxxnxq: '2025-2026-1',
    zsxnxqmc: '2025-2026-1',
    kclbmc: '',
    kcsxmc: '',
    tsklbmc: '',
    cjtjsm: '',
    bz: '',
    ...over
  };
}

describe('成绩：课程串拆成课程号与课程名', () => {
  it('"[BIOL3102]植物学Ⅱ" 拆成课程号与课程名', () => {
    assert.equal(courseCodeOf('[BIOL3102]植物学Ⅱ'), 'BIOL3102');
    assert.equal(courseNameOf('[BIOL3102]植物学Ⅱ'), '植物学Ⅱ');
  });

  it('没有方括号时整体当课程名，不把名字丢掉', () => {
    assert.equal(courseCodeOf('植物学Ⅱ'), '植物学Ⅱ');
    assert.equal(courseNameOf('植物学Ⅱ'), '植物学Ⅱ');
  });

  it('课程名里还有方括号时，只切掉开头那一个课程号', () => {
    assert.equal(courseNameOf('[A111]某[奇特]课程'), '某[奇特]课程');
  });
});

describe('成绩：哪些记录不参与均分与绩点', () => {
  it('教务标了「不参与统计」的不算 —— 这是教务自己的口径', () => {
    const row = normalizeGradeItem(raw({ kcxx: '[COST1138]人工智能通识', xf: 1, zcj: '合格', cjtjsm: '不参与所有成绩统计计算' }));
    assert.equal(isCountedForStats(row), false);
  });

  it('缓考的 0 分是占位符，不是真考了 0 分', () => {
    const row = normalizeGradeItem(raw({ kcxx: '[PE1002]体育Ⅱ', xf: 1, zcj: '0', jd: '0', cjbzmc: '缓考' }));
    assert.equal(isCountedForStats(row), false);
  });

  it('缺考同理', () => {
    const row = normalizeGradeItem(raw({ kcxx: '[X]缺考课', xf: 1, zcj: '0', jd: '0', cjbzmc: '缺考' }));
    assert.equal(isCountedForStats(row), false);
  });

  it('等级制成绩（合格 / A / 优秀）没有可比的分值', () => {
    assert.equal(isCountedForStats(normalizeGradeItem(raw({ zcj: '合格', jd: '0' }))), false);
    assert.equal(isCountedForStats(normalizeGradeItem(raw({ zcj: 'A', jd: '0' }))), false);
    assert.equal(isCountedForStats(normalizeGradeItem(raw({ zcj: '优秀', jd: '0' }))), false);
  });

  it('成绩位是空的也不算', () => {
    assert.equal(isCountedForStats(normalizeGradeItem(raw({ zcj: '', jd: '' }))), false);
  });

  it('正常的数字成绩（含 0 分与小数）要算', () => {
    assert.equal(isCountedForStats(normalizeGradeItem(raw({ zcj: '0', jd: '0' }))), true);
    assert.equal(isCountedForStats(normalizeGradeItem(raw({ zcj: '77.0', jd: '2.5' }))), true);
  });
});

describe('成绩汇总', () => {
  it('均分是算术平均，绩点是学分加权', () => {
    const { summary } = normalizeGrades([
      raw({ kcxx: '[MATH2112]高等数学', xf: 4, zcj: '70.0', jd: '2' }),
      raw({ kcxx: '[MATH2116]线性代数B', xf: 2, zcj: '68.0', jd: '1.5' })
    ]);
    // 均分 (70 + 68) / 2
    assert.equal(summary.average, 69);
    // 加权绩点 (4×2 + 2×1.5) / (4 + 2) = 11 / 6
    assert.equal(summary.gpa, 1.83);
    assert.equal(summary.counted, 2);
  });

  it('缓考与等级制成绩被排除在分子分母之外', () => {
    const { summary } = normalizeGrades([
      raw({ kcxx: '[MATH2112]高等数学', xf: 4, zcj: '70.0', jd: '2' }),
      raw({ kcxx: '[PE1002]体育Ⅱ', xf: 1, zcj: '0', jd: '0', cjbzmc: '缓考' }),
      raw({ kcxx: '[GC1220]军事技能训练', xf: 2, zcj: 'A', jd: '0', cjtjsm: '不参与所有成绩统计计算' })
    ]);
    // 若把缓考的 0 也算进来，均分会掉到 23.3 —— 正是这条断言要挡住的
    assert.equal(summary.average, 70);
    assert.equal(summary.gpa, 2);
    assert.equal(summary.counted, 1);
    assert.equal(summary.total, 3);
    assert.equal(summary.excluded, 2);
  });

  it('同一门课的补重记录只按最高分算一次，学分不被算两遍', () => {
    const { rows, summary } = normalizeGrades([
      raw({ kcxx: '[MATH2112]高等数学', xf: 4, zcj: '55.0', jd: '1', cjbzmc: '正常考试' }),
      raw({ kcxx: '[MATH2112]高等数学', xf: 4, zcj: '78.0', jd: '2.5', cjbzmc: '补考' })
    ]);
    // 列表照旧两条都出（那是用户要看懂自己到底考了几次）
    assert.equal(rows.length, 2);
    assert.equal(summary.counted, 1);
    assert.equal(summary.average, 78);
    assert.equal(summary.gpa, 2.5);
  });

  it('一门可统计的课都没有时给 null，而不是 0', () => {
    const { summary } = normalizeGrades([
      raw({ kcxx: '[GC1220]军事技能训练', xf: 2, zcj: 'A', jd: '0', cjtjsm: '不参与所有成绩统计计算' })
    ]);
    // 0 分和「算不出来」在界面上是两回事
    assert.equal(summary.average, null);
    assert.equal(summary.gpa, null);
    assert.equal(summary.total, 1);
  });

  it('空列表不炸', () => {
    const { rows, summary } = normalizeGrades([]);
    assert.deepEqual(rows, []);
    assert.equal(summary.average, null);
    assert.equal(summary.gpa, null);
    assert.equal(summary.total, 0);
  });

  it('行里保留分数字符串原样，界面直接显示教务给的那个值', () => {
    const { rows } = normalizeGrades([raw({ kcxx: '[MATH2112]高等数学', xf: 4, zcj: '77.0', jd: '2.5' })]);
    assert.equal(rows[0].score, '77.0');
    assert.equal(rows[0].scoreNum, 77);
    assert.equal(rows[0].point, '2.5');
    assert.equal(rows[0].code, 'MATH2112');
    assert.equal(rows[0].name, '高等数学');
  });
});

describe('成绩页的学期下拉', () => {
  it('最前面是「全部学期」，且它不带「当前学期」标记', () => {
    const terms = buildGradeTerms([{ id: '2025-2026-1', xnxqmc: '2025-2026 第1学期' }], [], ALL_TERM_ID);
    assert.equal(terms[0].id, '');
    assert.equal(terms[0].name, '全部学期');
    // current 是「教务标的当前学期」，只用来给下拉项加「（当前学期）」后缀。
    // 若「全部学期」跟着当前值变成 true，页面上就会显示成「全部学期（当前学期）」。
    assert.equal(terms[0].current, false);
    assert.equal(terms[1].id, '2025-2026-1');
    assert.equal(terms[1].current, false);
  });

  it('选了具体学期时，当前项跟着挪过去', () => {
    const terms = buildGradeTerms([{ id: '2025-2026-1', xnxqmc: '2025-2026 第1学期' }], [], '2025-2026-1');
    assert.equal(terms[0].current, false);
    assert.equal(terms[1].current, true);
  });

  it('教务取不到列表时用缓存里出现过的学期兜底，「全部学期」仍在', () => {
    const terms = buildGradeTerms(null, [{ xnxq_id: '2024-2025-2' }], ALL_TERM_ID);
    assert.equal(terms[0].id, '');
    assert.equal(terms[0].current, false);
    assert.ok(terms.some((t) => t.id === '2024-2025-2'));
  });
});
