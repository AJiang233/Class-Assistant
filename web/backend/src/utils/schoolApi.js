/**
 * 教务系统（数智教学微服务平台）接口客户端
 *
 * 鉴权方式：纯会话 Cookie（用户在自己的浏览器/App 里登录后由安卓端原生读出并上报）
 * 所有接口都在 https://szjw.njau.edu.cn 下，统一前缀 /api/xsd/
 *
 * 注意：教务系统对移动端 UA 有兼容问题（页面错乱），因此所有请求固定使用桌面 UA。
 */

export const SCHOOL_ORIGIN = 'https://szjw.njau.edu.cn';

/** 桌面 UA：教务系统用手机 UA 访问会出现渲染异常，这里固定伪装成 Edge 桌面端 */
export const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0';

/** 登录态失效（教务重定向到统一身份认证，返回的是 HTML 而不是 JSON） */
export class SchoolSessionExpired extends Error {
  constructor(message = '教务系统登录态已失效，请重新绑定') {
    super(message);
    this.name = 'SchoolSessionExpired';
  }
}

/** 教务接口返回体结构：{ data, status: "200", message, variables } */
export class SchoolClient {
  constructor(cookies) {
    this.cookies = cookies || '';
  }

  /**
   * 调用教务接口并返回解析后的 JSON
   * @param {string} path          如 /api/xsd/jsxsd/jczy/jxxnxq/dqxnxq
   * @param {object} [options]
   * @param {string} [options.method='POST']
   * @param {object} [options.body]     POST 的 JSON body
   * @param {object} [options.params]   追加到 URL 的查询参数
   */
  async request(path, options = {}) {
    const method = options.method || 'POST';
    const url = new URL(path, SCHOOL_ORIGIN);
    if (options.params) {
      for (const [key, value] of Object.entries(options.params)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const headers = {
      Cookie: this.cookies,
      'User-Agent': DESKTOP_UA,
      Referer: `${SCHOOL_ORIGIN}/xsd/`,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9'
    };
    const init = { method, headers };
    if (method !== 'GET' && method !== 'HEAD') {
      headers['Content-Type'] = 'application/json;charset=UTF-8';
      init.body = JSON.stringify(options.body === undefined ? {} : options.body);
    }

    let res;
    try {
      res = await fetch(url.toString(), init);
    } catch (e) {
      throw new Error(`无法连接教务系统：${e.message}`);
    }
    // 教务对未登录/登录态过期的请求直接返回 401（不是重定向到登录页）
    if (res.status === 401 || res.status === 403) throw new SchoolSessionExpired();
    if (!res.ok) throw new Error(`教务接口 ${path} 返回 HTTP ${res.status}`);

    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      // 返回 HTML = 被重定向到统一身份认证登录页
      throw new SchoolSessionExpired();
    }
    if (json && json.status && String(json.status) !== '200') {
      const message = String(json.message || '');
      if (/登录|认证|超时|session/i.test(message)) throw new SchoolSessionExpired();
      throw new Error(message || `教务接口 ${path} 返回异常`);
    }
    return json;
  }

  // ===== 基础信息 =====

  /** 当前登录用户（id 即各业务接口需要的 xsid / xsxxid）；该接口用 GET，且返回裸对象（无 data 包装） */
  async sessionUserInfo() {
    const json = await this.request('/api/xsd/qsmart/common/sessionUserInfo', { method: 'GET' });
    return json.data || json;
  }

  /** 全部学年学期列表，按时间倒序，id 形如 2026-2027-1 */
  async termList() {
    const json = await this.request('/api/xsd/jsxsd/jczy/jxxnxq/select', { body: { bean: {} } });
    return json.data || [];
  }

  /** 节次配置（第一节 08:00-08:45 这类）：课表网格的行 */
  async periodConfig(kbjcmsId, xnxqId) {
    const json = await this.request('/api/xsd/jsxsd/pkgl/kbsjsz/kbsjJcmxDetail', {
      method: 'GET',
      params: { kbjcmsid: kbjcmsId, xnxqid: xnxqId }
    });
    return json.data || [];
  }

  /** 教学行事历：每周对应的真实日期，用于算「某周周几是几号」 */
  async weekCalendar(xnxqId) {
    const json = await this.request('/api/xsd/jsxsd/jczy/jxjxxl/getByXnxq', {
      method: 'GET',
      params: { xnxqid: xnxqId }
    });
    return json.data || null;
  }

  // ===== 课表 =====

  /** 已安排课表（含星期、节次、周次、教室） */
  async arrangedCourses(xnxqId, kbjcmsId = 1) {
    const json = await this.request('/api/xsd/jsxsd/xsd/pkgl/grkbcx/queryGrkbxx', {
      body: { zc: '', kbjcmsId: String(kbjcmsId), xnxqId }
    });
    return json.data || [];
  }

  /** 未安排课表（还没排时间地点的课程） */
  async unscheduledCourses(xnxqId, kbjcmsId = 1) {
    const json = await this.request('/api/xsd/jsxsd/xsd/pkgl/grkbcx/wpkjxrw', {
      body: { xnxqId, kbjcmsId: String(kbjcmsId) }
    });
    return json.data || [];
  }

  // ===== 学业达成 / 学分 =====

  /** 学生基本信息 + 当前执行计划（返回体里的 zxjhid 就是学分接口要的 pyfaid） */
  async studentPlan(xsxxid) {
    const json = await this.request('/api/xsd/jsxsd/xjgl/xsxx/xsjbxx/detailBhzxjh', {
      params: { xsxxid }
    });
    return json.data || null;
  }

  /** 学业达成情况：按课程体系给出要求/已获/在修/还需学分 */
  async creditDetails(xsid, pyfaid, fxid = null) {
    const json = await this.request('/api/xsd/jsxsd/xjgl/xywcqk/details', {
      body: { xsid, pyfaid, fxid }
    });
    return json.data || null;
  }
}
