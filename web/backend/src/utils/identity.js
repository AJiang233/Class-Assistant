/**
 * 学号比对：教务绑定必须是本人，不能拿同学账号去换别人的课表。
 * 只做 trim 后的精确匹配，不去掉前导零——学号本身可能有意义。
 */
export function sameStudentId(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  return a.length > 0 && a === b;
}
