/**
 * 表单导出的纯格式化：把一行答案变成 CSV 文本。
 *
 * 只有 handleExportForm 用它，拆出来是 issue #22 —— 导出这块的坑全在转义细节上
 * （公式注入、引号、CRLF），单独一个文件才能盯着测，不用每次翻过一整个表单 handler。
 */

/** 单元格取值：多选拼顿号，其余转字符串 */
export function answerText(value) {
  if (Array.isArray(value)) return value.join('、');
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** CSV 单元格：中和公式注入 + 标准转义 */
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  // Excel 会把 = + - @ 开头的单元格当公式执行，导出的是全班学号姓名，必须先中和
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function buildCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}
