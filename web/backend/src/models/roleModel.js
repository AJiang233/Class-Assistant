/**
 * 自定义职位数据模型
 * 表结构：roles (id, name, permissions, created_at)
 * permissions 为 JSON 数组字符串，如 '["content:write"]'
 */
export class RoleModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * 获取全部自定义职位
   */
  async list() {
    const result = await this.db.prepare(
      'SELECT id, name, permissions, created_at FROM roles ORDER BY id ASC'
    ).all();
    return result.results;
  }

  /**
   * 根据职位名查找
   */
  async findByName(name) {
    const result = await this.db.prepare(
      'SELECT id, name, permissions FROM roles WHERE name = ?'
    ).bind(name).first();
    return result;
  }

  /**
   * 新增/更新自定义职位（按名称 upsert）
   * @param {string} name
   * @param {string} permissionsJson - JSON 数组字符串
   */
  async upsert(name, permissionsJson) {
    const result = await this.db.prepare(
      `INSERT INTO roles (name, permissions)
       VALUES (?, ?)
       ON CONFLICT(name) DO UPDATE SET permissions = excluded.permissions`
    ).bind(name, permissionsJson).run();
    return result;
  }

  /**
   * 根据 ID 删除自定义职位
   */
  async deleteById(id) {
    const result = await this.db.prepare(
      'DELETE FROM roles WHERE id = ?'
    ).bind(id).run();
    return result;
  }
}
