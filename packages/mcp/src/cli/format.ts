// 终端对齐工具：CJK 等宽字符按 2 列计，供 doctor / tools 等列对齐输出共用。
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += (ch.codePointAt(0) ?? 0) > 0x2e80 ? 2 : 1;
  return w;
}

export function padLabel(label: string, width: number): string {
  return label + ' '.repeat(Math.max(0, width - displayWidth(label)));
}
