/** 侧栏日期分组：fetchedAt → 日期 → 展示标签 */

/** fetchedAt 兼容 "YYYY-MM-DD HH:mm:ss" 与 "YYYY/MM/DD HH:mm:ss"（旧落盘产物）；解析失败返回 '' */
export function normalizeDate(s: string | undefined): string {
  const m = String(s || '')
    .replace(/\//g, '-')
    .match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : '';
}

/** 今天 / 昨天 / M月D日 / 跨年 YYYY年M月D日 / 未知日期 */
export function dateLabel(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return '未知日期';
  const [y, m, day] = d.split('-').map(Number);
  const p = (n: number) => String(n).padStart(2, '0');
  const now = new Date();
  const today = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
  const yst = new Date(now.getTime() - 864e5);
  if (d === today) return '今天';
  if (d === `${yst.getFullYear()}-${p(yst.getMonth() + 1)}-${p(yst.getDate())}`) return '昨天';
  return now.getFullYear() === y ? `${m}月${day}日` : `${y}年${m}月${day}日`;
}
