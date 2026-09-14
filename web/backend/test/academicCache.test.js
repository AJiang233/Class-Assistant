import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cacheDecision, cacheReasonOf, isFresh } from '../src/handlers/academicHandler.js';
import { SchoolSessionExpired } from '../src/utils/schoolApi.js';

const DAY = 24 * 60 * 60 * 1000;

/** D1 的 CURRENT_TIMESTAMP 是 UTC 的 "YYYY-MM-DD HH:MM:SS"，测试按同一格式造时间 */
function sqlTimeAgo(ms) {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/**
 * 课表缓存的新鲜期。
 *
 * 为什么盯这个：教务登录态大概一天就会被那边重置一次，抓不到新数据是常态，
 * 所以「多久算新鲜」直接决定用户平时打开课表到底走不走教务。窗口被人改小，
 * 表现不是报错而是「每次打开都慢一拍、偶尔还得重新登录」，很难联想到这里，
 * 所以把当前口径钉在测试里。
 */
describe('课表缓存新鲜期', () => {
  it('三天以内算新鲜，超过三天要重新抓', () => {
    assert.equal(isFresh(sqlTimeAgo(2 * DAY)), true);
    assert.equal(isFresh(sqlTimeAgo(4 * DAY)), false);
  });

  it('时间读不出来（空值 / 坏串）一律当作不新鲜', () => {
    // 宁可多抓一次，也不要把「不知道多久以前」的缓存当成新鲜的用
    assert.equal(isFresh(''), false);
    assert.equal(isFresh(null), false);
    assert.equal(isFresh('不是时间'), false);
  });
});

/**
 * 「这一轮为什么给的是缓存」。页面靠它决定说哪句话：
 * 登录态过期要给重新登录的入口，教务不可达只要说一句「等会儿会自己更新」。
 * 两者混成一句的话，用户不知道该不该动手，所以分开钉住。
 */
describe('回缓存的原因', () => {
  it('登录态过期报 expired，教务不可达报 unreachable', () => {
    assert.equal(cacheReasonOf(new SchoolSessionExpired('登录态失效')), 'expired');
    assert.equal(cacheReasonOf(new Error('fetch failed')), 'unreachable');
  });
});

/**
 * 「这次把缓存给不给用户」。这是本次改动的核心分支，也是那个让用户难受了很久的 bug：
 * 教务登录态一天左右就被重置，以前一过期就直接报「请重新绑定」，手上明明有课表也不给看。
 */
describe('要不要把缓存给出去', () => {
  const fresh = sqlTimeAgo(2 * DAY);
  const stale = sqlTimeAgo(4 * DAY);

  it('教务拉不动时缓存无条件优先 —— 过期、手动刷新都给', () => {
    assert.deepEqual(
      cacheDecision({ hasCache: true, liveError: new SchoolSessionExpired('登录态失效'), refresh: true, fetchedAt: stale }),
      { reason: 'expired' }
    );
    assert.deepEqual(
      cacheDecision({ hasCache: true, liveError: new Error('fetch failed'), refresh: false, fetchedAt: stale }),
      { reason: 'unreachable' }
    );
  });

  it('教务好着时：只有「没手动刷新 + 缓存新鲜」才用缓存', () => {
    assert.deepEqual(
      cacheDecision({ hasCache: true, liveError: null, refresh: false, fetchedAt: fresh }),
      { reason: null }
    );
    // 手动刷新就是用户明确要最新的，不能再拿旧的糊弄
    assert.equal(
      cacheDecision({ hasCache: true, liveError: null, refresh: true, fetchedAt: fresh }),
      null
    );
    // 缓存过了新鲜期，该去重抓
    assert.equal(
      cacheDecision({ hasCache: true, liveError: null, refresh: false, fetchedAt: stale }),
      null
    );
  });

  it('压根没有缓存时不给，调用方去重抓或报错', () => {
    assert.equal(
      cacheDecision({ hasCache: false, liveError: new SchoolSessionExpired('登录态失效'), refresh: false, fetchedAt: null }),
      null
    );
  });
});
