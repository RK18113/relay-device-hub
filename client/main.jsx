import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDown, ArrowDownToLine, ArrowRight, ArrowUp, ArrowUpRight, Battery, BatteryCharging, Check, ChevronLeft, ChevronRight, Clock3, CloudOff, Cpu, Download, ExternalLink, File, FileCode2, FileImage, Folder, HardDrive, Info, Laptop, LayoutGrid, LoaderCircle, LockKeyhole, MemoryStick, Monitor, RefreshCw, Search, ShieldCheck, Smartphone, Terminal, Thermometer, Wifi, X, Zap } from 'lucide-react';
import './style.css';
import DeviceControls from './device-controls.jsx';
import { watts, powerPlot } from './power.js';
import { celsius, gpuSleeping, thermalPlot } from './temperature.js';

const bytes = (n, precision = 1) => {
  if (n == null) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(4, Math.floor(Math.log(Math.max(1, n)) / Math.log(1024)));
  return `${(n / 1024 ** i).toFixed(i > 1 ? precision : 0)} ${units[i]}`;
};
const pct = n => n == null ? '—' : `${Math.round(n)}%`;
const ago = date => {
  if (!date) return 'No report yet';
  const seconds = Math.max(0, Math.round((Date.now() - new Date(date)) / 1000));
  return seconds < 10 ? 'just now' : seconds < 60 ? `${seconds}s ago` : seconds < 3600 ? `${Math.floor(seconds / 60)}m ago` : `${Math.floor(seconds / 3600)}h ago`;
};
const uptime = seconds => seconds >= 86400 ? `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h` : `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
const deviceIcon = kind => kind === 'laptop' ? Laptop : Monitor;
const profileName = name => ({ 'power-saver': 'Power saver', balanced: 'Balanced', performance: 'Performance' }[name] || 'Not reported');
const fileIcon = item => item.kind === 'folder' ? Folder : /\.(png|jpe?g|webp|gif|svg)$/i.test(item.name) ? FileImage : /\.(py|js|jsx|ts|ipynb|json|md|txt|sh)$/i.test(item.name) ? FileCode2 : File;

async function api(url, options) {
  const response = await fetch(url, { cache: 'no-store', ...options });
  const data = await response.json();
  if (!response.ok) throw Object.assign(new Error(data.error || 'Could not connect to Relay.'), { status: response.status });
  return data;
}

function Status({ device, compact = false }) {
  const label = { online: 'Online', stale: 'Delayed', offline: 'Offline', pending: 'Waiting' }[device.status] || 'Waiting';
  return <span className={`status ${device.status} ${compact ? 'compact' : ''}`}><span className="status-dot" />{label}</span>;
}
function Progress({ value, color = 'green' }) {
  return <div className={`progress ${color}`}><span style={{ width: `${Math.max(0, Math.min(100, value || 0))}%` }} /></div>;
}
function Empty({ icon: Icon = CloudOff, title, children, action }) {
  return <div className="empty"><span className="empty-icon"><Icon size={25} /></span><h3>{title}</h3><p>{children}</p>{action}</div>;
}
function Chart({ points = [], field = 'cpuPercent', color = '#b7aef6', height = 95, label = 'CPU use over the last hour' }) {
  const values = points.map(point => field === 'memory' ? point.memoryUsedBytes / point.memoryTotalBytes * 100 : point[field] || 0);
  if (values.length < 2) return <div className="chart-pending" style={{ height }}><Activity size={16} />Collecting history</div>;
  const width = 600, padding = 8;
  const coordinates = values.map((value, index) => `${padding + index / (values.length - 1) * (width - padding * 2)},${height - padding - Math.min(100, value) / 100 * (height - padding * 2)}`);
  const line = coordinates.join(' ');
  return <svg className="chart" role="img" aria-label={label} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" style={{ height }}>
    {[25, 50, 75].map(n => <line key={n} x1="0" x2={width} y1={height * n / 100} y2={height * n / 100} stroke="#2b2c36" strokeDasharray="3 6" />)}
    <polygon points={`${padding},${height} ${line} ${width - padding},${height}`} fill={color} opacity=".07" />
    <polyline points={line} fill="none" stroke={color} strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
  </svg>;
}

function ThermalHistory({ device, points = [] }) {
  const snapshot = device.snapshot, sleeping = gpuSleeping(snapshot);
  const latestIsRecent = Date.parse(device.receivedAt) >= Date.now() - 3600000;
  const chartPoints = latestIsRecent ? [...points.filter(point => Date.parse(point.receivedAt) !== Date.parse(device.receivedAt)), { receivedAt: device.receivedAt, temperatureC: snapshot?.temperatureC, gpu: snapshot?.gpu }] : points;
  return <section className="thermal-history" aria-label="Temperature history">
    <div className="history-heading"><h3><Thermometer size={15} />Temperature history</h3><span>Last hour · °C · {device.status === 'online' ? 'live reports' : 'last received reports'}</span></div>
    <div className="thermal-grid">{['cpu', 'gpu'].map(kind => {
      const plot = thermalPlot(chartPoints, kind, Math.max(90000, (device.intervalSeconds || 30) * 3000));
      const current = kind === 'cpu' ? snapshot?.temperatureC : snapshot?.gpu?.temperatureC;
      const source = kind === 'cpu' ? snapshot?.temperatureSource : snapshot?.gpu?.temperatureSource;
      const off = kind === 'gpu' && sleeping;
      return <article className="thermal-card" key={kind}>
        <div className="thermal-title"><span>{kind.toUpperCase()} temperature</span><strong>{off ? 'Powered down' : celsius(current)}</strong></div>
        <p className="thermal-source">{source || (off ? 'Temperature is not polled while the GPU sleeps.' : 'Sensor unavailable until a supported reading arrives.')}</p>
        {plot.readings.length ? <><div className="thermal-scale"><span>{plot.ceiling}°</span><span>0°</span></div><svg className="thermal-chart" role="img" aria-label={`${device.name} ${kind.toUpperCase()} temperature history`} viewBox="0 0 600 110" preserveAspectRatio="none">
          {[25, 50, 75].map(value => <line key={value} x1="0" x2="600" y1={102 - value / 100 * 94} y2={102 - value / 100 * 94} stroke="#2b2c36" strokeDasharray="3 6" />)}
          {plot.segments.map((segment, index) => segment.length > 1 ? <polyline key={index} points={segment.map(point => `${point.x},${point.y}`).join(' ')} fill="none" stroke={kind === 'cpu' ? '#b7aef6' : '#82c9dd'} strokeWidth="2" vectorEffect="non-scaling-stroke" /> : <circle key={index} cx={segment[0].x} cy={segment[0].y} r="2.5" fill={kind === 'cpu' ? '#b7aef6' : '#82c9dd'} />)}
        </svg><div className="thermal-range"><span>Low <strong>{celsius(plot.low)}</strong></span><span>Peak <strong>{celsius(plot.peak)}</strong></span></div></> : <div className="thermal-empty">{off ? 'GPU asleep · no temperature samples' : current == null ? 'No temperature readings available' : 'Collecting temperature history…'}</div>}
        <p className="thermal-sample">{kind === 'gpu' && !off && snapshot?.gpu?.sampledAt ? `GPU sampled ${ago(snapshot.gpu.sampledAt)}` : kind === 'cpu' ? `Reported ${ago(device.receivedAt)}` : 'Missing readings are shown as gaps.'}</p>
      </article>;
    })}</div>
  </section>;
}

function PowerHistory({ device, points = [] }) {
  const s = device.snapshot;
  const recent = Date.parse(device.receivedAt) >= Date.now() - 3600000;
  const history = recent ? [...points.filter(point => Date.parse(point.receivedAt) !== Date.parse(device.receivedAt)), { receivedAt: device.receivedAt, power: s?.power }] : points;
  const labels = { cpu: 'CPU package', gpu: 'GPU board', system: 'Total system' };
  return <section className="power-history" aria-label="Power consumption">
    <div className="history-heading"><h3><Zap size={15} />Power consumption</h3><span>Last hour · watts · {device.status === 'online' ? 'live reports' : 'last received reports'}</span></div>
    <div className="power-grid">{['cpu', 'gpu', 'system'].map((kind, index) => {
      const metric = s?.power?.[kind], off = kind === 'gpu' && gpuSleeping(s);
      const plot = powerPlot(history, kind, metric?.scope, Math.max(90000, (device.intervalSeconds || 30) * 3000));
      const color = ['#b7aef6', '#82c9dd', '#e9bd78'][index];
      return <article className="thermal-card power-card" key={kind}>
        <div className="thermal-title"><span>{labels[kind]}</span><strong style={{ color }}>{off ? 'Powered down' : watts(metric?.watts)}</strong></div>
        <p className="thermal-source">{metric?.source || 'Power sensor not available'}{metric?.scope === 'wall' ? ' · wall input' : metric?.scope === 'battery' ? ' · battery output' : ''}</p>
        {plot.readings.length ? <><div className="power-scale"><span>{plot.ceiling} W</span><span>0 W</span></div><svg className="thermal-chart" role="img" aria-label={`${device.name} ${labels[kind]} power history`} viewBox="0 0 600 110" preserveAspectRatio="none">
          {[25, 50, 75].map(n => <line key={n} x1="0" x2="600" y1={102 - n / 100 * 94} y2={102 - n / 100 * 94} stroke="#2b2c36" strokeDasharray="3 6" />)}
          {plot.segments.map((segment, i) => segment.length > 1 ? <polyline key={i} points={segment.map(p => `${p.x},${p.y}`).join(' ')} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" /> : <circle key={i} cx={segment[0].x} cy={segment[0].y} r="2.5" fill={color} />)}
        </svg><div className="thermal-range"><span>Peak <strong>{watts(plot.peak)}</strong></span><span>{plot.readings.length} samples</span></div></> : <div className="thermal-empty">{off ? 'GPU asleep · no power polling' : 'No measured power samples'}</div>}
        <p className="thermal-sample">{metric?.sampledAt ? `Sampled ${ago(metric.sampledAt)}` : 'Missing readings are not treated as zero.'}</p>
      </article>;
    })}</div><p className="power-footnote">CPU package and GPU board readings cover components only. Total system requires battery-discharge telemetry or an external meter; these readings are never added together as a total. CPU power is a recent 2-second average.</p>
  </section>;
}

function DeviceCard({ device, onOpen, points }) {
  const Icon = deviceIcon(device.kind), s = device.snapshot, memoryPercent = s ? s.memoryUsedBytes / s.memoryTotalBytes * 100 : 0;
  const diskPercent = s ? (1 - s.diskFreeBytes / s.diskTotalBytes) * 100 : 0;
  return <button className={`device-card ${device.status !== 'online' ? 'not-live' : ''}`} onClick={onOpen}>
    <div className="device-card-top"><span className={`device-illustration ${device.kind}`}><Icon size={29} strokeWidth={1.65} /></span><Status device={device} /></div>
    <div className="device-name-row"><div><span className="eyebrow">{device.role}</span><h3>{device.name}</h3></div><ArrowUpRight className="open-arrow" size={22} /></div>
    <p className="device-spec">{s?.cpuName?.replace(/\s+@.*$/, '').replace(/\d+-Core Processor/, '').replace(/\(R\)|\(TM\)/g, '') || device.description}</p>
    <div className="card-metrics"><div><span>CPU</span><strong>{s ? pct(s.cpuPercent) : '—'}</strong></div><div><span>Memory</span><strong>{s ? `${bytes(s.memoryUsedBytes, 1).replace(' GB', '')} / ${bytes(s.memoryTotalBytes, 0)}` : '—'}</strong></div></div>
    <div className="device-temperatures"><span title={s?.temperatureSource || 'CPU sensor unavailable'}><Thermometer size={13} />CPU <strong>{celsius(s?.temperatureC)}</strong></span><span title={s?.gpu?.temperatureSource || 'GPU temperature unavailable'}>GPU <strong>{gpuSleeping(s) ? 'Powered down' : celsius(s?.gpu?.temperatureC)}</strong></span></div>
    <Chart points={points} height={54} label={`${device.name} CPU history`} />
    <div className="card-bottom"><span>{device.kind === 'laptop' ? <Battery size={15} /> : <Zap size={15} />}{s?.battery ? `${pct(s.battery.percent)} · ${s.battery.status}` : profileName(s?.powerProfile)}</span><span>{ago(device.receivedAt)}</span></div>
    {diskPercent > 95 && <div className="card-warning"><HardDrive size={14} />Only {bytes(s.diskFreeBytes)} free</div>}
  </button>;
}

function ProcessTable({ data, query = '', sort = 'cpu', limit = 100, compact = false }) {
  const processes = [...(data?.processes || [])].filter(item => `${item.name} ${item.user} ${item.pid}`.toLowerCase().includes(query.toLowerCase()));
  processes.sort((a, b) => sort === 'memory' ? b.memoryBytes - a.memoryBytes : b.cpuPercent - a.cpuPercent || b.memoryBytes - a.memoryBytes);
  return <div className="table-scroll"><table className={`process-table ${compact ? 'compact-table' : ''}`}><thead><tr><th>Process</th>{!compact && <th>PID</th>}<th>CPU <ArrowDown size={12} /></th><th>Memory</th>{!compact && <th>User</th>}</tr></thead><tbody>
    {processes.slice(0, limit).map(item => <tr key={item.pid}><td><span className="process-symbol"><Terminal size={14} /></span><span className="process-name">{item.name}</span></td>{!compact && <td className="mono muted">{item.pid}</td>}<td className="mono"><span className={item.cpuPercent >= 20 ? 'cpu-active' : ''}>{item.cpuPercent.toFixed(1)}%</span></td><td className="mono">{bytes(item.memoryBytes)}</td>{!compact && <td className="muted">{item.user}</td>}</tr>)}
    {!processes.length && <tr><td colSpan={compact ? 3 : 5} className="table-empty">{query ? 'No processes match your search.' : 'Waiting for a process report.'}</td></tr>}
  </tbody></table></div>;
}

function FilesView({ devices, selected, onSelect }) {
  const [root, setRoot] = useState('home'), [folder, setFolder] = useState(''), [listing, setListing] = useState(null);
  const [busy, setBusy] = useState(true), [error, setError] = useState(''), [query, setQuery] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => { setRoot('home'); setFolder(''); setQuery(''); }, [selected]);
  useEffect(() => {
    const controller = new AbortController(); setBusy(true); setError(''); setListing(null);
    api(`/api/files/${selected}?${new URLSearchParams({ root, path: folder })}`, { signal: controller.signal })
      .then(setListing).catch(error => { if (error.name !== 'AbortError') setError(error.message); }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [selected, root, folder, retry]);
  const roots = listing?.roots || [{ id: 'home', name: 'Home' }, { id: 'documents', name: 'Documents' }, { id: 'downloads', name: 'Downloads' }, { id: 'desktop', name: 'Desktop' }];
  const selectedDevice = devices.find(d => d.id === selected);
  const pieces = folder.split('/').filter(Boolean), entries = (listing?.entries || []).filter(item => item.name.toLowerCase().includes(query.toLowerCase()));
  return <section className="panel files-panel">
    <div className="panel-heading"><div><h2>Your files, within reach</h2><p>Browse personal folders without copying them between devices.</p></div><span className="read-only"><LockKeyhole size={13} />Read only</span></div>
    <div className="file-toolbar"><div className="device-tabs">{devices.map(d => <button key={d.id} className={selected === d.id ? 'selected' : ''} onClick={() => onSelect(d.id)}>{React.createElement(deviceIcon(d.kind), { size: 16 })}{d.name}</button>)}</div><label className="search"><Search size={16} /><input aria-label="Find a file" placeholder="Find in this folder…" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    <div className="file-layout"><aside className="folder-sidebar"><span className="eyebrow">PERSONAL FOLDERS</span>{roots.map(item => <button key={item.id} className={root === item.id ? 'active' : ''} onClick={() => { setRoot(item.id); setFolder(''); setQuery(''); }}><Folder size={17} />{item.name}</button>)}<p>Files stay on {selectedDevice?.name}. Hidden settings and credentials are excluded.</p></aside>
      <div className="folder-content"><div className="breadcrumbs"><button aria-label="Parent folder" disabled={!folder} onClick={() => setFolder(pieces.slice(0, -1).join('/'))}><ChevronLeft size={17} /></button><button onClick={() => setFolder('')}>{roots.find(item => item.id === root)?.name || 'Home'}</button>{pieces.map((part, index) => <React.Fragment key={index}><ChevronRight size={13} /><button onClick={() => setFolder(pieces.slice(0, index + 1).join('/'))}>{part}</button></React.Fragment>)}</div>
      {busy ? <div className="loading-files"><LoaderCircle className="spin" size={23} /><span>Opening folder…</span></div> : error ? <Empty title="Folder unavailable" action={<button className="button secondary" onClick={() => setRetry(n => n + 1)}>Try again</button>}>{error}</Empty> : <><div className="table-scroll"><table className="file-table"><thead><tr><th>Name</th><th>Modified</th><th>Size</th><th aria-label="Download" /></tr></thead><tbody>{entries.map(item => {
        const Icon = fileIcon(item), filePath = [...pieces, item.name].join('/');
        return <tr key={item.name}><td>{item.kind === 'folder' ? <button className="file-name folder-name" onClick={() => { setFolder(filePath); setQuery(''); }}><Icon size={19} /><span>{item.name}</span></button> : <span className="file-name"><Icon size={19} /><span>{item.name}</span>{item.kind === 'link' && <span className="muted small">link</span>}</span>}</td><td className="muted">{new Date(item.modifiedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</td><td className="mono muted">{item.kind === 'file' ? bytes(item.size) : '—'}</td><td>{item.kind === 'file' && <a className="icon-button" title={`Download ${item.name}`} aria-label={`Download ${item.name}`} href={`/api/files/${selected}/download?${new URLSearchParams({ root, path: filePath })}`}><ArrowDownToLine size={17} /></a>}</td></tr>;
      })}{!entries.length && <tr><td colSpan="4" className="table-empty">{query ? 'No files match your search.' : 'This folder is empty.'}</td></tr>}</tbody></table></div><div className="file-count">{entries.length} items{listing?.truncated ? ' · first 1,000 entries shown' : ''}<span>Folders and downloads only</span></div></>}
      </div>
    </div>
  </section>;
}

function AddDevice({ onClose, onCreated, existingDevice }) {
  const [form, setForm] = useState({ name: '', kind: 'desktop', address: '', sshUser: '', intervalSeconds: 30, nvidiaMonitor: false });
  const [created, setCreated] = useState(existingDevice || null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const set = (name, value) => setForm(previous => ({ ...previous, [name]: value }));
  async function submit(event) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const result = await api('/api/devices', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form) });
      setCreated(result.device); onCreated();
    } catch (error) { setError(error.message); }
    finally { setBusy(false); }
  }
  return <div className="modal-backdrop" onClick={onClose}><section className="modal enroll-modal" role="dialog" aria-modal="true" aria-labelledby="enroll-title" onClick={e => e.stopPropagation()}><button className="icon-button modal-close" aria-label="Close dialog" onClick={onClose}><X size={20} /></button><span className="modal-icon">{created ? <Check size={28} /> : <Monitor size={28} />}</span><h2 id="enroll-title">{created ? `Connect ${created.name}.` : 'Bring another device along.'}</h2>{created ? <><p>Download this device’s agent bundle, then extract it on that Linux computer.</p><a className="button primary agent-download" href={`/api/devices/${created.id}/enrollment`}><Download size={16} />Download agent bundle</a><ol><li><strong>Extract the ZIP on the device</strong><span>It contains the lightweight Python agent, an installer and this device’s configuration.</span></li><li><strong>Run the installer there</strong><code>python3 install-agent.py --config device.json</code></li><li><strong>Optional: power sensors and controls</strong><code>sudo bash install-device-access.sh</code><span>Adds a read-only CPU energy sampler and normal shutdown/reboot permission for your account. No action runs during setup.</span></li><li><strong>Watch for its first report</strong><span>The device will appear online once it can reach this workspace through Tailscale.</span></li></ol><p className="modal-note">This bundle contains a private device key. Keep it on the computer you’re connecting. Linux and systemd are required.</p><button className="button primary modal-done" onClick={onClose}>Done <Check size={16} /></button></> : <form onSubmit={submit}><p>Connect a Linux desktop, laptop or server. Tailscale provides the connection; installing its Relay agent enables reports. Phones can install and view Relay without an agent.</p><label>Device name<input required maxLength="60" value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Studio desktop" /></label><div className="form-row"><label>Device type<select value={form.kind} onChange={e => { set('kind', e.target.value); if (e.target.value === 'laptop') set('nvidiaMonitor', false); }}><option value="desktop">Desktop</option><option value="laptop">Laptop</option><option value="server">Server</option></select></label><label>Report interval<select value={form.intervalSeconds} onChange={e => set('intervalSeconds', Number(e.target.value))}><option value="30">30 seconds</option><option value="60">1 minute</option><option value="120">2 minutes</option></select></label></div><div className="enroll-divider">OPTIONAL · FOR FILES AND DEVICE CONTROLS</div><label>Tailscale SSH address<input value={form.address} required={Boolean(form.sshUser)} onChange={e => set('address', e.target.value)} placeholder="device-name or Tailscale IP" /></label><label>Linux username<input value={form.sshUser} required={Boolean(form.address)} onChange={e => set('sshUser', e.target.value)} placeholder="Your account on that device" /></label><small className="form-help">The workspace host needs approved SSH access to that account. Files stay read-only; device actions require confirmation.</small><label className="checkbox-label"><input type="checkbox" disabled={form.kind === 'laptop'} checked={form.nvidiaMonitor} onChange={e => set('nvidiaMonitor', e.target.checked)} /><span>Monitor an NVIDIA GPU<small>Desktop/server only, to avoid waking laptop graphics.</small></span></label>{error && <div className="notice error">{error}</div>}<button className="button primary modal-done" disabled={busy}>{busy ? <LoaderCircle size={16} className="spin" /> : <ArrowRight size={16} />}Add device</button></form>}</section></div>;
}

function App() {
  const [tab, setTab] = useState(location.hash.slice(1) || 'overview'), [selected, setSelected] = useState('');
  const [devices, setDevices] = useState([]), [session, setSession] = useState(null), [processes, setProcesses] = useState(null);
  const [history, setHistory] = useState({}), [error, setError] = useState(null), [busy, setBusy] = useState(false), [updated, setUpdated] = useState(null);
  const [query, setQuery] = useState(''), [sort, setSort] = useState('cpu'), [install, setInstall] = useState(null), [modal, setModal] = useState(null);
  const [online, setOnline] = useState(navigator.onLine);
  const installed = matchMedia('(display-mode: standalone)').matches;
  const navigate = page => { setTab(page); location.hash = page; setQuery(''); };
  async function refresh() {
    setBusy(true);
    try { const data = await api('/api/devices'); setDevices(data.devices); setSelected(previous => data.devices.some(d => d.id === previous) ? previous : data.devices[0]?.id || ''); setUpdated(new Date()); setError(null); }
    catch (error) { setError(error); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    api('/api/session').then(setSession).catch(setError); refresh();
    const interval = setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 10000);
    const status = () => setOnline(navigator.onLine), hash = () => setTab(location.hash.slice(1) || 'overview');
    const prompt = event => { event.preventDefault(); setInstall(event); };
    window.addEventListener('online', status); window.addEventListener('offline', status); window.addEventListener('hashchange', hash); window.addEventListener('beforeinstallprompt', prompt);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    return () => { clearInterval(interval); window.removeEventListener('online', status); window.removeEventListener('offline', status); window.removeEventListener('hashchange', hash); window.removeEventListener('beforeinstallprompt', prompt); };
  }, []);
  useEffect(() => {
    if (!devices.length) return;
    let cancelled = false;
    const load = async () => {
      const results = await Promise.all(devices.map(async device => {
        try { return [device.id, (await api(`/api/devices/${device.id}/history`)).points]; } catch { return [device.id, []]; }
      }));
      if (!cancelled) setHistory(Object.fromEntries(results));
    };
    load(); const interval = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 30000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [devices.map(d => d.id).join(',')]);
  useEffect(() => {
    if (!['overview', 'processes'].includes(tab) || !devices.length) return;
    let cancelled = false;
    const load = () => api(`/api/devices/${selected}/processes`).then(result => { if (!cancelled) setProcesses(result); }).catch(() => { if (!cancelled) setProcesses(null); });
    setProcesses(null); load();
    const interval = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [selected, tab, devices.length]);
  const device = devices.find(d => d.id === selected) || devices[0], laptop = devices.find(d => d.kind === 'laptop'), pc = devices.find(d => d.kind === 'desktop') || devices.find(d => d.kind === 'server') || devices[0];
  const s = device?.snapshot, pcData = pc?.snapshot, laptopData = laptop?.snapshot;
  const available = devices.filter(d => d.status === 'online').length;
  const initials = (session?.user?.split('@')[0].split(/[._-]/).filter(Boolean).slice(0, 2).map(s => s[0]).join('') || 'R').toUpperCase();
  const pages = [{ id: 'overview', label: 'Overview', icon: LayoutGrid }, { id: 'devices', label: 'Devices', icon: Monitor }, { id: 'processes', label: 'Processes', icon: Activity }, { id: 'files', label: 'Files', icon: Folder }];
  const titles = { overview: ['Your desk, wherever you are.', 'A little distance. Everything still within reach.'], devices: ['A closer look at your devices.', 'Live resources, power states and the details that matter.'], processes: ['See what’s doing the work.', 'A clear view of the processes on your personal devices.'], files: ['The right file. Right here.', 'Access your personal folders from any connected device.'] };
  const heading = titles[tab] || titles.overview;
  async function installApp() {
    if (install) { await install.prompt(); await install.userChoice; setInstall(null); }
    else setModal('install');
  }
  return <div className="app-shell">
    <aside className="sidebar"><a className="brand" href="#overview"><span className="brand-mark"><span /><span /><span /></span>relay<span className="brand-dot">.</span></a><div className="workspace-label">YOUR WORKSPACE</div><nav aria-label="Main navigation">{pages.map(page => <button key={page.id} className={tab === page.id ? 'active' : ''} onClick={() => navigate(page.id)}><page.icon size={19} />{page.label}{page.id === 'devices' && <span className="nav-count">{devices.length || '—'}</span>}</button>)}</nav><div className="sidebar-note"><span className="sidebar-orbit"><Monitor size={24} /><span /><Laptop size={19} /></span><strong>One place. Your devices.</strong><p>A private connection to the workspace you built.</p></div><div className="sidebar-bottom"><button onClick={() => setModal('about')}><ShieldCheck size={17} /><span>Private with Tailscale<small>Only your account</small></span><Info size={14} /></button><span className="workspace-owner"><span className="avatar">{initials}</span><span>Private workspace<small>{devices.length} devices · one workspace</small></span></span></div></aside>
    <main><header className="topbar"><div className="breadcrumb-title">Workspace <ChevronRight size={13} /><span>{pages.find(p => p.id === tab)?.label || 'Overview'}</span></div><div className="topbar-right"><a className="tailscale-link" href="https://login.tailscale.com/admin/machines" target="_blank" rel="noopener noreferrer" aria-label="Open Tailscale dashboard"><ExternalLink size={14} /><span>Tailscale</span></a><span className={`connection-label ${!online ? 'disconnected' : ''}`}><span className="status-dot" />{online ? 'Private connection' : 'Offline'}</span><button className="icon-button" title="About Relay" aria-label="About Relay" onClick={() => setModal('about')}><Info size={18} /></button><span className="avatar">{initials}</span></div></header>
      <div className="page-content"><div className="page-heading"><div><div className="page-kicker"><span className="tiny-line" />{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</div><h1>{heading[0]}</h1><p>{heading[1]}</p></div><div className="heading-actions"><button className="button secondary refresh-button" onClick={refresh} disabled={busy}><RefreshCw size={15} className={busy ? 'spin' : ''} /><span>Refresh</span></button>{!installed && <button className="button primary" onClick={installApp}><Download size={15} />Install app</button>}</div></div>
      {error && <div className="notice error"><CloudOff size={18} /><span>{error.status === 401 ? 'Connect to Tailscale and open your private Relay address to view this workspace.' : 'Connection interrupted. Last received readings are shown; they may be out of date.'}</span><button onClick={refresh}>Retry</button></div>}
      {!devices.length ? <section className="panel"><Empty icon={error ? LockKeyhole : LoaderCircle} title={error ? 'Your workspace stays private' : 'Connecting to your workspace'}>{error ? error.message : 'Getting the latest reports from your devices.'}</Empty></section> : <>
      {['overview', 'devices'].includes(tab) && <><div className="summary-strip"><div><span className="summary-icon green"><Wifi size={19} /></span><span><small>Devices online</small><strong>{available}<span className="summary-denominator"> / {devices.length}</span></strong></span><span className="summary-detail">{available === devices.length ? 'All connected' : 'Last-seen data available'}</span></div><div><span className="summary-icon gold">{laptopData?.battery?.status === 'Charging' ? <BatteryCharging size={20} /> : <Battery size={20} />}</span><span><small>Laptop battery</small><strong>{pct(laptopData?.battery?.percent)}</strong></span><span className="summary-detail">{laptopData?.battery?.status || 'Not reported'}{laptop?.status !== 'online' && ' · last report'}</span></div><div><span className="summary-icon lilac"><Cpu size={20} /></span><span><small>Host workload</small><strong>{pct(pcData?.cpuPercent)}</strong></span><span className="summary-detail">{profileName(pcData?.powerProfile)}{pc?.status !== 'online' && ' · last report'}</span></div></div>
      <div className="section-label"><h2>Your devices <span>{devices.length}</span></h2><div className="section-actions"><button className="text-button" onClick={() => setModal('add-device')}>Add device <ArrowRight size={13} /></button><span className="live-note"><span className="status-dot" />Time-stamped reports</span></div></div><div className="device-grid">{devices.map(item => <DeviceCard key={item.id} device={item} points={history[item.id]} onOpen={() => { setSelected(item.id); navigate('devices'); }} />)}</div></>}
      {tab === 'devices' && <div className="enrollment-help"><Info size={17} /><div><strong>Bring another device along</strong><p>Join it to your Tailscale network, add it here, then install its Relay agent. Phones can view and install this website; phone telemetry is not supported.</p></div><button className="text-button" onClick={() => setModal('add-device')}>Add device <ArrowRight size={14} /></button></div>}
      {tab === 'overview' && <><div className="overview-lower"><section className="panel compute-panel"><div className="panel-heading"><div><span className="eyebrow">COMPUTE</span><h2>Compute overview</h2></div><span className="gpu-badge"><Cpu size={22} /></span></div><div className="gpu-name">{pcData?.gpu?.name || 'GPU report pending'}</div><p className="muted">Heavy lifting stays on your PC. Your laptop travels light.</p><div className="gpu-metrics"><div><span>GPU usage</span><strong>{pct(pcData?.gpu?.utilization)}</strong></div><div><span>Temperature</span><strong>{pcData?.gpu?.temperatureC == null ? '—' : `${pcData.gpu.temperatureC}°`}<small>C</small></strong></div><div><span>Power</span><strong>{pcData?.gpu?.powerW == null ? '—' : Math.round(pcData.gpu.powerW)}<small>W</small></strong></div></div><div className="compute-bottom"><span><span className="status-dot" />{pc?.status === 'online' ? pcData?.gpu?.utilization > 5 ? 'GPU active' : 'Ready when you are' : 'Last GPU report'}<small>{pcData?.gpu?.sampledAt ? ago(pcData.gpu.sampledAt) : ''}</small></span><button className="text-button" onClick={() => { setSelected(pc?.id || devices[0]?.id); navigate('processes'); }}>View processes <ArrowRight size={15} /></button></div></section>
      <section className="panel travel-panel"><div className="panel-heading"><div><span className="eyebrow">ON THE GO</span><h2>Portable power</h2></div><Laptop size={25} /></div><div className="power-state"><span className="power-state-icon"><Zap size={20} /></span><div><strong>{laptopData?.gpu?.mode === 'intel' ? 'Intel-only graphics' : 'Graphics on demand'}</strong><span>{laptopData?.gpu?.state === 'D3cold' ? 'NVIDIA is powered down' : laptopData?.gpu ? `NVIDIA state: ${laptopData.gpu.state}` : 'Waiting for graphics report'}</span></div><span className="mini-check"><Check size={14} /></span></div><div className="travel-details"><div><span>Power profile</span><strong>{profileName(laptopData?.powerProfile)}</strong></div><div><span>Battery health</span><strong>{pct(laptopData?.battery?.healthPercent)}</strong></div><div><span>Current battery draw</span><strong>{laptopData?.battery?.powerW == null ? '—' : `${laptopData.battery.powerW.toFixed(1)} W`}</strong></div></div><button className="text-button" onClick={() => { setSelected(laptop?.id || devices[0]?.id); navigate('devices'); }}>View laptop details <ArrowRight size={15} /></button></section></div>
      <section className="panel process-preview"><div className="panel-heading"><div><h2>What’s running</h2><p>{devices.find(d => d.id === selected)?.name} · {processes?.total || 0} processes in the last report</p></div><button className="text-button" onClick={() => navigate('processes')}>See all processes <ArrowUpRight size={15} /></button></div><ProcessTable data={processes} compact limit={5} /></section></>}
      {tab === 'devices' && device && <section className="panel detail-panel"><div className="panel-heading"><div><span className="eyebrow">DEVICE DETAILS</span><h2>{device.name}</h2><p>{s?.os || 'Waiting for the first report'} · Updated {ago(device.receivedAt)}</p></div><Status device={device} /></div><div className="device-tabs detail-tabs">{devices.map(d => <button key={d.id} className={d.id === selected ? 'selected' : ''} onClick={() => setSelected(d.id)}>{React.createElement(deviceIcon(d.kind), { size: 16 })}{d.name}</button>)}</div>{s ? <><div className="detail-stats"><div><Cpu size={20} /><span>CPU usage</span><strong>{pct(s.cpuPercent)}</strong><small>{s.cpuCores} logical cores</small></div><div><MemoryStick size={20} /><span>Memory</span><strong>{bytes(s.memoryUsedBytes)}</strong><small>{bytes(s.memoryTotalBytes)} total</small></div><div><HardDrive size={20} /><span>Available storage</span><strong className={s.diskFreeBytes / s.diskTotalBytes < .05 ? 'text-amber' : ''}>{bytes(s.diskFreeBytes)}</strong><small>{bytes(s.diskTotalBytes)} total</small></div><div><Clock3 size={20} /><span>Uptime</span><strong>{uptime(s.uptimeSeconds)}</strong><small>{profileName(s.powerProfile)}</small></div></div>{s.diskFreeBytes / s.diskTotalBytes < .05 && <div className="notice warning"><HardDrive size={17} />Storage is getting tight on {device.name}. {bytes(s.diskFreeBytes)} is available. No files have been changed.</div>}<div className="history-heading"><h3>CPU activity</h3><span>Last hour · {device.status === 'online' ? 'live reports' : 'last received reports'}</span></div><Chart points={history[device.id]} height={135} /><div className="chart-axis"><span>1 hour ago</span><span>Now</span></div><ThermalHistory device={device} points={history[device.id]} /><PowerHistory device={device} points={history[device.id]} /><DeviceControls key={device.id} device={device} /><div className="hardware-list"><div><span>Processor</span><strong>{s.cpuName}</strong></div><div><span>Graphics</span><strong>{s.gpu?.name || 'Not reported'}{s.gpu?.state === 'D3cold' ? ' · powered down' : s.gpu?.state ? ` · ${s.gpu.state}` : ''}</strong></div><div><span>Network received / sent</span><strong>{bytes(s.network.rxBytesPerSecond)}/s <span className="muted"> / </span>{bytes(s.network.txBytesPerSecond)}/s</strong></div>{s.battery && <><div><span>Battery capacity / original</span><strong>{s.battery.fullWh?.toFixed(1)} / {s.battery.designWh?.toFixed(1)} Wh</strong></div><div><span>Battery condition</span><strong>{pct(s.battery.healthPercent)} health · {s.battery.status}</strong></div></>}</div><div className="detail-actions"><button className="text-button setup-agent-button" onClick={() => setModal('agent-setup')}>Agent setup <Download size={14} /></button><button className="button secondary" onClick={() => navigate('processes')}><Activity size={16} />View processes</button><button className="button primary" onClick={() => navigate('files')}><Folder size={16} />Browse files</button></div></> : <Empty title="Waiting for this device">Its latest report will appear here when it connects.</Empty>}</section>}
      {tab === 'processes' && <section className="panel processes-panel"><div className="panel-heading"><div><h2>Running processes</h2><p>{processes?.total || 0} total · Top {Math.min(processes?.processes?.length || 0, 250)} reported · Updated {ago(processes?.receivedAt)}</p></div><span className="read-only"><ShieldCheck size={14} />View only</span></div><div className="process-toolbar"><div className="device-tabs">{devices.map(d => <button key={d.id} className={selected === d.id ? 'selected' : ''} onClick={() => setSelected(d.id)}>{React.createElement(deviceIcon(d.kind), { size: 16 })}{d.name}</button>)}</div><div className="process-filters"><label className="search"><Search size={16} /><input placeholder="Search processes…" aria-label="Search processes" value={query} onChange={e => setQuery(e.target.value)} /></label><select aria-label="Sort processes" value={sort} onChange={e => setSort(e.target.value)}><option value="cpu">CPU usage</option><option value="memory">Memory</option></select></div></div>{device?.status !== 'online' && <div className="notice warning"><Clock3 size={17} />Showing the last report. This device is {device?.status || 'unavailable'}.</div>}<ProcessTable data={processes} query={query} sort={sort} /><div className="table-footer">CPU: 100% represents one logical core. Process names are collected; command arguments are excluded.</div></section>}
      {tab === 'files' && <FilesView devices={devices} selected={selected} onSelect={setSelected} />}
      <footer className="page-footer"><span><ShieldCheck size={14} />Your devices. Your private connection.</span><span>{updated ? `Last checked ${ago(updated)}` : 'Connecting…'}</span></footer>
      </>}
      </div>
    </main>
    <nav className="mobile-nav" aria-label="Mobile navigation">{pages.map(page => <button key={page.id} className={tab === page.id ? 'active' : ''} onClick={() => navigate(page.id)}><page.icon size={20} /><span>{page.label}</span></button>)}</nav>
    {['add-device', 'agent-setup'].includes(modal) && <AddDevice existingDevice={modal === 'agent-setup' ? device : null} onClose={() => setModal(null)} onCreated={refresh} />}
    {modal && !['add-device', 'agent-setup'].includes(modal) && <div className="modal-backdrop" onClick={() => setModal(null)}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" onClick={e => e.stopPropagation()}><button className="icon-button modal-close" aria-label="Close dialog" onClick={() => setModal(null)}><X size={20} /></button><span className="modal-icon">{modal === 'install' ? <Smartphone size={28} /> : <ShieldCheck size={28} />}</span><h2 id="modal-title">{modal === 'install' ? 'Your workspace, one tap away.' : 'A private window into your devices.'}</h2>{modal === 'install' ? <><p>Install Relay to open it like an app, with its own icon and window.</p><ol><li><strong>Android / Chrome</strong><span>Open the browser menu, choose “Add to Home screen”, then “Install”.</span></li><li><strong>Desktop / Chrome or Brave</strong><span>Use the install icon in the address bar or the browser’s app menu.</span></li><li><strong>iPhone / Safari</strong><span>Tap Share, then “Add to Home Screen”.</span></li></ol><p className="modal-note">Keep Tailscale connected to reach your devices. The app shell can open offline; live readings and files need a connection.</p></> : <><p>Relay is available through your personal Tailscale connection and restricted to your account.</p><div className="about-lines"><span><Activity size={17} /><strong>Automatic device reports</strong><small>Configurable interval · 48 hours of metric history</small></span><span><Folder size={17} /><strong>Read-only file access</strong><small>Hidden files and private-key paths excluded</small></span><span><LockKeyhole size={17} /><strong>Names, not command arguments</strong><small>Confirmed lock, reboot and shutdown · no terminal access</small></span></div><p className="modal-note">Your host runs this workspace and must stay online in Linux. Devices join through Add device and an installed Relay agent; a Tailscale connection alone does not enroll them. Phones can view the hub, but phone telemetry is not collected.</p></>}<button className="button primary modal-done" onClick={() => setModal(null)}>Got it <Check size={16} /></button></section></div>}
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
