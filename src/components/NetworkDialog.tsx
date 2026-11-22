// 网络挂载连接的新建/编辑对话框（Files > Network 面板调用，条件渲染的 modal）。
// 表单按协议切换字段：SMB 填 host/share/domain，WebDAV 填 URL；
// password 新增必填、编辑留空表示保留原密码（界面明确提示）。
// 布局：CSS Grid 两列——label 列右对齐、控件列自适应；Protocol 用单选按钮组。
import { useState } from 'react';
import {
  ClassicyButton,
  ClassicyCheckbox,
  ClassicyForm,
  ClassicyFormButtonRow,
  ClassicyInput,
  ClassicyRadioInput,
  ClassicyWindow,
} from 'classicy';
import type { MountConnection, MountInput, MountProtocol } from '../api';

interface Props {
  appId: string;
  icon: string;
  editing: MountConnection | null;
  onCancel: () => void;
  onSave: (input: MountInput) => Promise<void>;
}

const EMPTY = {
  name: '',
  protocol: 'smb' as MountProtocol,
  host: '',
  share: '',
  domain: '',
  url: '',
  username: '',
  password: '',
  autoMount: false,
};

export function NetworkDialog({ appId, icon, editing, onCancel, onSave }: Props) {
  const [form, setForm] = useState(() =>
    editing
      ? {
          name: editing.name,
          protocol: editing.protocol,
          host: editing.host || '',
          share: editing.share || '',
          domain: editing.domain || '',
          url: editing.url || '',
          username: editing.username || '',
          password: '',
          autoMount: editing.autoMount,
        }
      : { ...EMPTY }
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const set = (k: keyof typeof form, v: string | boolean) =>
    setForm((f) => ({ ...f, [k]: v }));

  const protocolInputs = [
    { id: 'smb', label: 'SMB / CIFS', checked: form.protocol === 'smb' },
    { id: 'webdav', label: 'WebDAV', checked: form.protocol === 'webdav' },
  ];

  const submit = async () => {
    setError('');
    if (!form.name.trim()) return setError('Please enter a name.');
    if (!form.username.trim()) return setError('Please enter a username.');
    if (!editing && !form.password) return setError('Please enter a password.');
    const input: MountInput = {
      name: form.name.trim(),
      protocol: form.protocol,
      username: form.username.trim(),
      autoMount: form.autoMount,
    };
    if (form.protocol === 'smb') {
      input.host = form.host.trim();
      input.share = form.share.trim();
      input.domain = form.domain.trim();
    } else {
      input.url = form.url.trim();
    }
    if (form.password) input.password = form.password;

    setBusy(true);
    try {
      await onSave(input);
    } catch (e) {
      setError((e as Error).message || 'Save failed');
      setBusy(false);
    }
  };

  return (
    <ClassicyWindow
      id="fm-network-dialog"
      appId={appId}
      title={editing ? 'Edit Network Location' : 'New Network Location'}
      icon={icon}
      modal
      closable={false}
      zoomable={false}
      collapsable={false}
      resizable={false}
      initialSize={[460, 400]}
      initialPosition={['center', 'center']}
    >
      <ClassicyForm
        layout="dialog"
        onSubmitFunc={(e) => {
          e.preventDefault();
          void submit();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      >
        <div className="sp-net-dialog">
          <label htmlFor="net-name">Name</label>
          <ClassicyInput
            id="net-name"
            prefillValue={form.name}
            placeholder="e.g. Office NAS"
            onChangeFunc={(e) => set('name', e.target.value)}
          />

          <label>Protocol</label>
          <ClassicyRadioInput
            name="fm-net-protocol"
            align="rows"
            inputs={protocolInputs}
            disabled={busy}
            onClickFunc={(id) => set('protocol', id as MountProtocol)}
          />

          {form.protocol === 'smb' ? (
            <>
              <label htmlFor="net-host">Server</label>
              <ClassicyInput
                id="net-host"
                prefillValue={form.host}
                placeholder="192.168.1.10"
                onChangeFunc={(e) => set('host', e.target.value)}
              />
              <label htmlFor="net-share">Share</label>
              <ClassicyInput
                id="net-share"
                prefillValue={form.share}
                placeholder="public"
                onChangeFunc={(e) => set('share', e.target.value)}
              />
              <label htmlFor="net-domain">Domain</label>
              <ClassicyInput
                id="net-domain"
                prefillValue={form.domain}
                placeholder="WORKGROUP"
                onChangeFunc={(e) => set('domain', e.target.value)}
              />
            </>
          ) : (
            <>
              <label htmlFor="net-url">URL</label>
              <ClassicyInput
                id="net-url"
                prefillValue={form.url}
                placeholder="https://dav.example.com/remote.php/dav"
                onChangeFunc={(e) => set('url', e.target.value)}
              />
              <span className="sp-net-hint sp-net-grid-wide">
                Do not include credentials in the URL.
              </span>
            </>
          )}

          <label htmlFor="net-user">Username</label>
          <ClassicyInput
            id="net-user"
            prefillValue={form.username}
            placeholder="alice"
            onChangeFunc={(e) => set('username', e.target.value)}
          />
          <label htmlFor="net-pwd">Password</label>
          <ClassicyInput
            id="net-pwd"
            type="password"
            prefillValue=""
            placeholder={editing ? 'Leave blank to keep' : '••••••••'}
            onChangeFunc={(e) => set('password', e.target.value)}
          />
          <span aria-hidden="true" />
          <ClassicyCheckbox
            id="net-auto"
            label="Mount at startup"
            checked={form.autoMount}
            onClickFunc={(v) => set('autoMount', v)}
          />

          {error && <div className="sp-net-error sp-net-grid-wide">{error}</div>}

          <ClassicyFormButtonRow className="sp-net-grid-wide">
            <ClassicyButton disabled={busy} onClickFunc={onCancel}>
              Cancel
            </ClassicyButton>
            <ClassicyButton isDefault buttonType="submit" disabled={busy}>
              {busy ? 'Saving…' : 'Save'}
            </ClassicyButton>
          </ClassicyFormButtonRow>
        </div>
      </ClassicyForm>
    </ClassicyWindow>
  );
}
