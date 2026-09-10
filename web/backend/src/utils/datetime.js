export function toLocalDateTime(value) {
  if (!value) return null;
  const matched = String(value).trim().replace('T', ' ')
    .match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(:\d{2})?/);
  if (!matched) return null;
  return matched[1] + (matched[2] || ':00');
}
