import { useEffect, useRef, useState } from 'react';
import pwaIcon from '../pwa/icons/icon-192.png';

// 动画时长（ms）：需与 styles.css 中进度条动画时长保持一致
const SPLASH_MS = 1600;

// 背景平铺纹理：Mini logo 与「WatchDog OS」字样交错排布（复刻 Mac OS 8 安装器桌面图案）。
// 在 JS 里 encodeURIComponent 后内联，避免 CSS data-URI 的转义坑。
const TILE_SVG = [
  "<svg xmlns='http://www.w3.org/2000/svg' width='192' height='112'>",
  "<g fill='none' stroke='#5c66bf' stroke-width='2'>",
  "<rect x='8' y='6' width='30' height='30' rx='7'/>",
  "<rect x='24' y='62' width='30' height='30' rx='7'/>",
  "<path d='M14 24 Q23 31 32 24'/>",
  "<path d='M30 80 Q39 87 48 80'/>",
  "</g>",
  "<g fill='#5c66bf'>",
  "<circle cx='17' cy='17' r='2'/><circle cx='29' cy='17' r='2'/>",
  "<circle cx='33' cy='73' r='2'/><circle cx='45' cy='73' r='2'/>",
  "</g>",
  "<text x='44' y='30' font-family='Georgia, serif' font-size='21' fill='#5c66bf'>WatchDog OS</text>",
  "<text x='62' y='86' font-family='Georgia, serif' font-size='21' fill='#5c66bf'>WatchDog OS</text>",
  "</svg>",
].join('');

/**
 * Mac OS 8 风格启动画面（安装器式 splash + 分段进度条）。
 * 动画保证最短播放时长；鉴权探测结果（ready）就绪且动画播完后才回调 onDone，
 * 探测先返回也不跳帧，探测迟迟不返回则停在 splash 末尾等待。
 */
export function BootScreen({ ready, onDone }: { ready: boolean; onDone: () => void }) {
  const [animDone, setAnimDone] = useState(false);
  // 只通知一次：StrictMode 下 effect 会跑两遍，避免 onDone 触发两次
  const notified = useRef(false);

  useEffect(() => {
    const t = setTimeout(() => setAnimDone(true), SPLASH_MS);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (animDone && ready && !notified.current) {
      notified.current = true;
      onDone();
    }
  }, [animDone, ready, onDone]);

  return (
    <div
      className="sp-boot sp-boot-splash sp-boot-fade"
      style={{ backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(TILE_SVG)}")` }}
    >
      <div className="sp-boot-panel">
        <div className="sp-boot-panel-inner">
          <div className="sp-boot-logo">
            <img src={pwaIcon} alt="" />
          </div>
          <div className="sp-boot-wordmark">
            WatchDog <span className="sp-boot-wordmark-os">OS</span>
          </div>
        </div>
        <div className="sp-boot-status">Starting Up...</div>
        <div className="sp-boot-progress" role="progressbar" aria-label="Starting Up">
          <div className="sp-boot-progress-fill" />
        </div>
      </div>
    </div>
  );
}
