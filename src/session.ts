/**
 * 会话生命周期收口：主动退出（Sign Out）与会话失效（任一接口 401）走同一条路径。
 *
 * 为什么必须集中处理：
 *  1. 各应用各自 `catch Unauthorized → onLogout()`，只要漏一处就会出现「界面还在、接口全 401」
 *     的半死状态（用户以为还登录着，实际什么都点不动）；
 *  2. 只清服务端 Cookie 不够：classicy 把桌面 / 窗口 / 应用数据持久化在 localStorage，
 *     上一会话看到的内容会原样出现在下一个登录者面前；
 *  3. 轮询 store、收藏夹缓存、宿主机 FS 树都是模块级单例，仅切换 React 树不足以清掉内存里的
 *     上一会话数据，因此退出流程末尾统一整页重载。
 */

/** 会话相关、退出时必须清除的 localStorage 键（服务端数据 / 桌面持久化状态） */
const SESSION_KEYS = [
  'classicyDesktopState', // classicy 持久化的桌面 / 窗口 / 菜单 / 应用数据
  'classicyStorage', // classicy 应用数据（含宿主机 FS 树镜像）
  'classicyStorage:seq',
  'srv-editor-recent', // 最近打开的文件（服务端路径）
  'watchdog-chat-history', // 旧版聊天记录（服务端数据）
  'watchdog-chat-sessions',
];

/** 前缀型键（旧版按会话 id 存的聊天消息体） */
const SESSION_KEY_PREFIXES = ['watchdog-chat-session:'];

/**
 * 清除本地会话存储。
 * 只清「服务端数据 / 会话态」，纯外观偏好（字号、主题、视图模式）保留——那些不含会话内容。
 * 任何异常（隐私模式禁用 storage）都吞掉：退出流程不能因为清缓存失败而中断。
 */
export function clearClientSession(): void {
  try {
    for (const k of SESSION_KEYS) localStorage.removeItem(k);
    const kill: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (k && SESSION_KEY_PREFIXES.some((p) => k.startsWith(p))) kill.push(k);
    }
    kill.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* 存储不可用：忽略 */
  }
}

/** 已在收尾中：防止并发的多个 401 / 重复点击触发多次重载 */
let ending = false;

/**
 * 「刚退出」标记（sessionStorage）。
 * 为什么需要：重载后 App 靠静默探测决定落在哪一屏，而探测在网络异常时按「已登录」处理
 * （避免后端短暂不可用时把用户挡在登录页外）。主动退出必须**无论探测结果如何**都停在登录页，
 * 因此显式留一个一次性标记，读完即删。
 */
const SIGNED_OUT_FLAG = 'wd-signed-out';

/**
 * 结束会话：清本地存储 → 整页导航回 SPA 入口。
 * 首次调用后置位，后续调用直接返回（幂等）。
 *
 * 用 `location.replace` 而非 `reload`：不留下可后退的「已退出但仍渲染旧数据」历史记录。
 */
export function endSession(): void {
  if (ending) return;
  ending = true;
  clearClientSession();
  try {
    sessionStorage.setItem(SIGNED_OUT_FLAG, '1');
  } catch {
    /* 存储不可用：忽略（退化为正常探测） */
  }
  window.location.replace(window.location.href);
}

/** 读取并清除「刚退出」标记（App 启动时调用：命中则直接渲染登录页，不做鉴权探测） */
export function consumeSignedOutFlag(): boolean {
  try {
    const hit = sessionStorage.getItem(SIGNED_OUT_FLAG) === '1';
    if (hit) sessionStorage.removeItem(SIGNED_OUT_FLAG);
    return hit;
  } catch {
    return false;
  }
}

/** 任一接口返回 401 时由 api 层调用（登录接口的「密码错误」除外） */
export function notifyUnauthorized(): void {
  endSession();
}

/** 仅供测试复位（生产代码不调用） */
export function __resetSessionState(): void {
  ending = false;
}
