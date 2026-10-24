import React, { useEffect, useRef, useState } from 'react';
import { LockKeyhole, Power, RotateCw, X, LoaderCircle } from 'lucide-react';

const actions = { lock: { label: 'Lock screen', icon: LockKeyhole }, reboot: { label: 'Reboot', icon: RotateCw }, poweroff: { label: 'Power off', icon: Power } };
async function api(url, body) {
  const response = await fetch(url, { cache: 'no-store', ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || 'Device action unavailable.');
  return value;
}

export default function DeviceControls({ device }) {
  const [selected, select] = useState(null), [challenge, setChallenge] = useState(null), [name, setName] = useState('');
  const [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const closeRef = useRef(null), modalRef = useRef(null), trigger = useRef(null), busyRef = useRef(false);
  busyRef.current = busy;
  useEffect(() => {
    if (!selected) return;
    trigger.current = document.activeElement;
    modalRef.current?.focus();
    const keydown = event => {
      if (event.key === 'Escape' && !busyRef.current) select(null);
      if (event.key === 'Tab') {
        const nodes = [...(modalRef.current?.querySelectorAll('button:not(:disabled), input:not(:disabled)') || [])];
        if (event.shiftKey && document.activeElement === nodes[0]) { event.preventDefault(); nodes.at(-1)?.focus(); }
        else if (!event.shiftKey && (document.activeElement === nodes.at(-1) || document.activeElement === modalRef.current)) { event.preventDefault(); nodes[0]?.focus(); }
      }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); trigger.current?.focus(); };
  }, [selected]);
  async function open(action) {
    select(action); setChallenge(null); setName(''); setAck(false); setError(''); setNotice(''); setBusy(true);
    try { setChallenge(await api(`/api/devices/${device.id}/actions/prepare`, { action })); }
    catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  async function execute(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api(`/api/devices/${device.id}/actions`, { action: selected, challenge: challenge.challenge,
        confirmation: selected === 'lock' ? device.name : name, acknowledged: ack });
      const action = selected; select(null); setNotice(`${actions[action].label} scheduled on ${device.name}. Waiting for device status…`);
      await new Promise(resolve => setTimeout(resolve, 4500));
      try {
        const status = await api(`/api/devices/${device.id}/actions/${result.jobId}`);
        setNotice(status.status === 'failed' ? status.message : status.status === 'requested'
          ? `${device.name}: the login manager accepted the ${actions[action].label.toLowerCase()} request. Check the device to confirm completion.`
          : `${device.name}: ${status.message} Check its state before retrying.`);
      } catch { setNotice(`${device.name} disconnected after the request. ${device.hostsRelay ? 'Relay will be unavailable while its host is off or restarting. ' : ''}Check the device’s state before retrying.`); }
    } catch (error) { setError(error.message); setChallenge(null); }
    finally { setBusy(false); }
  }
  return <section className="device-controls" aria-label="Device controls">
    <div><h3>Device controls</h3><p>Requests run as the device’s Relay account. Shutdown inhibitors remain enforced.</p></div>
    <div className="control-buttons">{Object.entries(actions).map(([action, { label, icon: Icon }]) => {
      const cap = device.snapshot?.controls?.[action];
      return <button key={action} className="button secondary" disabled={busy || device.status !== 'online' || !cap?.available}
        title={cap?.reason || (device.status !== 'online' ? 'Device is offline' : cap ? label : 'Update the agent to enable controls')}
        onClick={() => open(action)}><Icon size={15} />{label}</button>;
    })}</div>
    {Object.values(device.snapshot?.controls || {}).some(cap => !cap.available) && <p className="control-help">Unavailable actions need an active desktop session or the optional device-access installer. See Agent setup.</p>}
    {notice && <div className="notice" role="status">{notice}</div>}
    {selected && <div className="modal-backdrop"><section ref={modalRef} className="modal action-modal" tabIndex={-1} role="dialog" aria-modal="true" aria-labelledby="action-title">
      <button ref={closeRef} className="icon-button modal-close" aria-label="Cancel device action" disabled={busy} onClick={() => select(null)}><X size={20} /></button>
      <h2 id="action-title">{actions[selected].label} · {device.name}</h2>
      <p>{selected === 'lock' ? 'Lock graphical sessions belonging to this device’s Relay account. Running work continues.' : 'This stops running work, including model training and notebooks. Save your files first.'}</p>
      {device.hostsRelay && selected !== 'lock' && <p className="host-warning">This device hosts Relay. The dashboard and all file access will disconnect until this host is back online. Power off requires a separate way to turn it on again.</p>}
      <form onSubmit={execute}>
        {selected !== 'lock' && <label className="confirm-name">Type <strong>{device.name}</strong> to confirm<input autoComplete="off" aria-label="Confirm device name" value={name} onChange={e => setName(e.target.value)} /></label>}
        <label className="action-ack"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)} />{selected === 'lock' ? 'I want to lock this device’s screen.' : 'I have saved my work and understand running tasks will stop.'}</label>
        {error && <p className="notice error" role="alert">{error} Close and reopen this dialog to retry.</p>}
        <p className="control-help">Confirmation expires after 60 seconds. The action is scheduled with a 3-second delay.</p>
        <div className="confirmation-buttons"><button type="button" className="button secondary" disabled={busy} onClick={() => select(null)}>Cancel</button><button className="button primary" disabled={busy || !challenge || !ack || (selected !== 'lock' && name !== device.name)}>{busy ? <LoaderCircle className="spin" size={15} /> : null}{actions[selected].label}</button></div>
      </form>
    </section></div>}
  </section>;
}
