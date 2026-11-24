import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ClassicyApp,
  ClassicyButton,
  ClassicyPopUpMenu,
  ClassicyWindow,
  useClassicyAboutMenu,
} from 'classicy';
import { fetchServerTime } from '../api';
import type { ServerTime } from '../api';
import { useAppOpen } from '../hooks/useAppOpen';
import { quitMenuItem } from '../quitMenuItem';
// ⚠️ 必须带 ?no-inline，否则 classicy 桌面图标遮罩会静默失效（docs/icon-pipeline.md §6.2）
import clockIcon from '../assets/icons/clock.svg?no-inline';

const APP_ID = 'srv-clock.app';
const APP_NAME = 'Clock';
/** 应用图标：自绘 32×32 像素圆表盘（白面 + 10:10 指针 + 红色秒针），见 src/assets/icons/clock.svg */
const ICON = clockIcon;

const ZONE_OPTIONS = [
  { value: 'Asia/Shanghai', label: '北京 · Asia/Shanghai' },
  { value: 'Asia/Tokyo', label: '东京 · Asia/Tokyo' },
  { value: 'Asia/Kolkata', label: '新德里 · Asia/Kolkata' },
  { value: 'Europe/London', label: '伦敦 · Europe/London' },
  { value: 'America/New_York', label: '纽约 · America/New_York' },
  { value: 'America/Los_Angeles', label: '洛杉矶 · America/Los_Angeles' },
  { value: 'UTC', label: 'UTC' },
];

interface TimeParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
  weekday: string;
}

/** 用显式 timeZone 取本地化时间片段，不受浏览器所在时区影响。 */
function timeParts(ms: number, timeZone: string): TimeParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(ms));
  const out: Record<string, string> = {};
  for (const p of parts) out[p.type] = p.value;
  // 部分 ICU 在午夜把 hour12:false 的 0 点输出为 "24"
  const weekday = new Intl.DateTimeFormat('zh-CN', { timeZone, weekday: 'long' }).format(new Date(ms));
  return {
    year: out.year,
    month: out.month,
    day: out.day,
    hour: out.hour === '24' ? '00' : out.hour,
    minute: out.minute,
    second: out.second,
    weekday,
  };
}

function fmtSigned(ms: number): string {
  const v = Math.round(ms);
  return `${v >= 0 ? '+' : ''}${v}`;
}

/** 表盘刻度：60 根，整点加粗。 */
const TICKS = Array.from({ length: 60 }, (_, i) => {
  const a = (i * 6 - 90) * Math.PI / 180;
  const major = i % 5 === 0;
  const r0 = major ? 82 : 88;
  const r1 = 94;
  return {
    key: i,
    major,
    x1: 100 + r0 * Math.cos(a),
    y1: 100 + r0 * Math.sin(a),
    x2: 100 + r1 * Math.cos(a),
    y2: 100 + r1 * Math.sin(a),
  };
});

export function ClockApp() {
  const open = useAppOpen(APP_ID);
  const { aboutMenuItem, aboutWindow } = useClassicyAboutMenu(APP_ID, APP_NAME, ICON);

  // 客户端时钟相对服务器的校正量（ms）。初始 0：首次同步完成前先用本地时间兜底。
  const offsetRef = useRef(0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [status, setStatus] = useState<'syncing' | 'synced' | 'error'>('syncing');
  const [info, setInfo] = useState<ServerTime | null>(null);
  const [timeZone, setTimeZone] = useState<string | null>(null);
  const [errorText, setErrorText] = useState('');

  const sync = useCallback(async () => {
    setStatus('syncing');
    const sentAt = Date.now();
    try {
      const s = await fetchServerTime();
      const receivedAt = Date.now();
      const rtt = receivedAt - sentAt;
      // NTP 式单边估算：服务器在响应发出时刻的时间 + 半程往返 = 客户端收到时的服务器时间
      offsetRef.current = s.nowMs + rtt / 2 - receivedAt;
      setInfo(s);
      // 首次同步时采用服务器时区；之后用户手动切换的时区不再被覆盖
      setTimeZone((prev) => prev ?? s.timeZone);
      setStatus('synced');
      setErrorText('');
      setNowMs(Date.now() + offsetRef.current);
    } catch (e) {
      // 校时失败不回退到本地时间（会跳变），沿用上次 offset
      setStatus('error');
      setErrorText(e instanceof Error ? e.message : '请求失败');
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    void sync();
    const syncTimer = window.setInterval(() => void sync(), 60_000);
    return () => window.clearInterval(syncTimer);
  }, [open, sync]);

  useEffect(() => {
    if (!open) return;
    const tick = window.setInterval(() => setNowMs(Date.now() + offsetRef.current), 200);
    return () => window.clearInterval(tick);
  }, [open]);

  const zone = timeZone ?? 'Asia/Shanghai';
  const p = timeParts(nowMs, zone);
  const hour12 = Number(p.hour) % 12;
  const minute = Number(p.minute);
  const second = Number(p.second);
  // 秒针按秒跳动（与数字秒数同步跳变）；分针/时针随秒缓动。
  // 200ms 轮询保证跳变紧跟整秒边界，不做毫秒插值。
  const secAngle = second * 6;
  const minAngle = (minute + second / 60) * 6;
  const hourAngle = (hour12 + minute / 60) * 30;

  const zoneOptions = useMemo(
    () => (zone && ZONE_OPTIONS.some((o) => o.value === zone)
      ? ZONE_OPTIONS
      : [{ value: zone, label: `${zone}（服务器）` }, ...ZONE_OPTIONS]),
    [zone]
  );

  const appMenu = useMemo(
    () => [
      {
        id: 'clock-menu',
        title: APP_NAME,
        menuChildren: [
          aboutMenuItem,
          { id: 'spacer' },
          quitMenuItem(APP_ID, APP_NAME, ICON),
        ],
      },
    ],
    [aboutMenuItem]
  );

  const serverOffset = info?.offsetMs ?? 0;
  const clientOffset = Math.round(offsetRef.current);

  return (
    <ClassicyApp id={APP_ID} name={APP_NAME} icon={ICON} defaultWindow="clock-main">
      <ClassicyWindow
        id="clock-main"
        title={APP_NAME}
        icon={ICON}
        appId={APP_ID}
        resizable
        zoomable
        collapsable
        closable
        initialSize={[520, 520]}
        initialPosition={['center', 'center']}
        minimumSize={[380, 420]}
        appMenu={appMenu}
      >
        <div className="sp-clock-body">
          <div className="sp-clock-main">
            <svg className="sp-clock-face" viewBox="0 0 200 200" role="img" aria-label="模拟时钟，带秒针">
              <circle className="sp-clock-rim" cx="100" cy="100" r="97" />
              <circle className="sp-clock-dial" cx="100" cy="100" r="94" />
              {TICKS.map((t) => (
                <line
                  key={t.key}
                  className={t.major ? 'sp-clock-tick sp-clock-tick-major' : 'sp-clock-tick'}
                  x1={t.x1} y1={t.y1} x2={t.x2} y2={t.y2}
                />
              ))}
              {[
                { label: '12', x: 100, y: 60 },
                { label: '3', x: 141, y: 105 },
                { label: '6', x: 100, y: 150 },
                { label: '9', x: 59, y: 105 },
              ].map((n) => (
                <text key={n.label} className="sp-clock-num" x={n.x} y={n.y}>{n.label}</text>
              ))}
              <line className="sp-clock-hand-hour" x1="100" y1="108" x2="100" y2="46"
                transform={`rotate(${hourAngle} 100 100)`} />
              <line className="sp-clock-hand-minute" x1="100" y1="112" x2="100" y2="28"
                transform={`rotate(${minAngle} 100 100)`} />
              <line className="sp-clock-hand-second" x1="100" y1="122" x2="100" y2="20"
                transform={`rotate(${secAngle} 100 100)`} />
              <circle className="sp-clock-hub" cx="100" cy="100" r="6" />
              <circle className="sp-clock-hub-dot" cx="100" cy="100" r="2" />
            </svg>

            <div className="sp-clock-digital">
              <div className="sp-clock-digits">{p.hour}:{p.minute}:{p.second}</div>
              <div className="sp-clock-date">{p.year} 年 {Number(p.month)} 月 {Number(p.day)} 日 · {p.weekday}</div>
              <div className="sp-clock-zone">{zone}</div>
            </div>
          </div>

          <div className="sp-clock-toolbar">
            <ClassicyPopUpMenu
              id="sp-clock-zone"
              label="时区"
              labelPosition="left"
              labelSize="small"
              size="small"
              options={zoneOptions}
              selected={zone}
              onChangeFunc={(e) => setTimeZone(e.target.value)}
            />
            <ClassicyButton buttonSize="small" disabled={status === 'syncing'} onClickFunc={() => void sync()}>
              立即同步
            </ClassicyButton>
          </div>

          <div className={`sp-clock-status ${status === 'error' ? 'sp-clock-status-error' : ''}`}>
            {status === 'synced' && info && (
              <>
                <span>● 已同步 · {info.source === 'ntp' ? `NTP（stratum ${info.stratum ?? '?'}）` : '系统时间'}</span>
                <span>服务器偏差 {fmtSigned(serverOffset)}ms</span>
                <span>往返 {info.delayMs == null ? '—' : `${Math.round(info.delayMs)}ms`}</span>
                <span>本机校正 {fmtSigned(clientOffset)}ms</span>
              </>
            )}
            {status === 'syncing' && <span>○ 正在与服务器校时…</span>}
            {status === 'error' && <span>● 校时失败（{errorText}），沿用上次校正值</span>}
          </div>
        </div>
      </ClassicyWindow>
      {aboutWindow}
    </ClassicyApp>
  );
}
