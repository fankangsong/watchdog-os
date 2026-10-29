import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import 'classicy/dist/classicy.css';
import 'classicy/dist/fonts.css';
import './styles.css';
// 断点层：必须在任何渲染之前把布局档位写进 <html data-wd-layout>，
// 否则窄屏首帧会先按桌面布局画一次再切到移动外壳（肉眼可见的闪动）
import { initViewport } from './responsive';
// classicy 内置 Finder（Macintosh HD）接入宿主机文件系统的 FS Adapter（模块级自动注册，
// 必须在桌面渲染前生效——启动时 reconcile 会用宿主机目录整树替换内存假数据）
import './hostFsAdapter';
import { App } from './App';
import { registerPwa } from './pwa';

const root = document.getElementById('root');
if (!root) throw new Error('Root element not found');

initViewport();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>
);

// 注册 Service Worker（仅生产构建生效）：离线资源缓存 + PWA 安装/独立窗口能力
registerPwa();
