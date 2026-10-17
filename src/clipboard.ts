// 剪贴板工具：优先 async Clipboard API（需安全上下文，localhost 可用）；
// HTTP 内网 IP 部署场景下 navigator.clipboard 为 undefined 或 writeText 被
// NotAllowedError 拒绝，回落隐藏 textarea + execCommand('copy')。
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 非安全上下文会 reject，走 execCommand 兜底
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}
