/* ===== URL 查询参数工具 =====
 *
 * 全部「无头截图可复现验证」的开关都从这里读。DSH 侧看不到浏览器控制台，
 * 唯一证据通道是 `_tools/webgpu-shot.mjs` 带 URL 参数出图 ⇒ 凡是需要 A/B
 * 对比的量，都必须在 URL 上可覆盖（否则 leva 面板只能在人手点的时候改）。
 *
 * 约定：
 *   ?k=1.5        数字
 *   ?k=1,2,3      三维向量
 *   ?k=ff8800     颜色（# 可省）
 *   缺省或解析失败 ⇒ 回落到调用方给的默认值，绝不抛错。
 */

export const QS = new URLSearchParams(window.location.search);

export function QSTR(key: string, dflt: string | null = null): string | null {
    return QS.get(key) ?? dflt;
}

export function QNUM(key: string, dflt: number): number;
export function QNUM(key: string): number | null;
export function QNUM(key: string, dflt?: number): number | null {
    const s = QS.get(key);
    if (s === null || s === '') return dflt ?? null;
    const v = parseFloat(s);
    if (Number.isFinite(v)) return v;
    return dflt ?? null;
}

export function QVEC(key: string, dflt: [number, number, number]): [number, number, number] {
    const s = QS.get(key);
    if (!s) return dflt;
    const a = s.split(',').map(Number);
    return a.length === 3 && a.every(Number.isFinite) ? (a as [number, number, number]) : dflt;
}

export function QCOL(key: string, dflt: string | null = null): string | null {
    const s = QS.get(key);
    if (!s) return dflt;
    const t = s.startsWith('#') ? s.slice(1) : s;
    return /^[0-9a-fA-F]{6}$/.test(t) ? '#' + t : dflt;
}

export function QFLAG(key: string): boolean {
    const s = QS.get(key);
    return s === '1' || s === 'true' || s === '';
}
