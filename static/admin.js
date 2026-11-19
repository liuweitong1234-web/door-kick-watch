(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const DAY = 864e5;
  const TOKEN_KEY = 'dkw_admin_token';
  const STATUS_LABELS = { new: 'New', verified: 'Verified', forwarded: 'Forwarded to police', rejected: 'Rejected' };
  const STATUS_COLORS = { new: '#ea8a00', verified: '#1f7a4d', forwarded: '#2563eb', rejected: '#8a8a8a' };

  let token = '';
  let reports = [];
  let map = null;
  let markerLayer = null;
  const markers = new Map();
  let fitted = false;

  function h(tag, attrs, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  }

  const store = {
    get() { try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; } },
    set(v) { try { sessionStorage.setItem(TOKEN_KEY, v); } catch (_) { /* private mode */ } },
    clear() { try { sessionStorage.removeItem(TOKEN_KEY); } catch (_) { /* ignore */ } },
  };

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
  }

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      ...opts,
      headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      signOut();
      throw new Error('Your access token was not accepted.');
    }
    if (!res.ok) {
      let msg = `Request failed (${res.status}).`;
      try { msg = (await res.json()).error || msg; } catch (_) { /* not JSON */ }
      throw new Error(msg);
    }
    return res;
  }

  const dtf = new Intl.DateTimeFormat(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const fmt = (iso) => dtf.format(new Date(iso));

  // ------------------------------------------------------------ sign in / out

  function showDashboard(show) {
    $('#login').hidden = show;
    $('#dashboard').hidden = !show;
    $('#sign-out').hidden = !show;
  }

  function signOut() {
    token = '';
    store.clear();
    showDashboard(false);
  }

  async function signIn(candidate) {
    token = candidate;
    const res = await api('/api/admin/reports');
    reports = (await res.json()).reports;
    store.set(token);
    showDashboard(true);
    initMap();
    render();
  }

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = $('#login-error');
    err.hidden = true;
    try {
      await signIn($('#token').value.trim());
      $('#token').value = '';
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
  $('#sign-out').addEventListener('click', signOut);

  // ------------------------------------------------------------ map + insights

  function initMap() {
    if (map) { map.invalidateSize(); return; }
    map = L.map('admin-map').setView([39.8, -98.6], 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    markerLayer = L.layerGroup().addTo(map);
  }

  function renderMap(rows) {
    markerLayer.clearLayers();
    markers.clear();
    for (const r of rows) {
      const m = L.circleMarker([r.lat, r.lng], {
        radius: 7, weight: 2, color: '#fff', fillColor: STATUS_COLORS[r.status], fillOpacity: 0.95,
      }).bindPopup(() => h('div', null,
        h('strong', null, r.address), h('br'),
        fmt(r.occurred_at), h('br'),
        `Status: ${STATUS_LABELS[r.status]}`));
      m.addTo(markerLayer);
      markers.set(r.id, m);
    }
    if (!fitted && rows.length) {
      map.fitBounds(L.latLngBounds(rows.map((r) => [r.lat, r.lng])).pad(0.2), { maxZoom: 15 });
      fitted = true;
    }
  }

  function renderInsights() {
    const since = Date.now() - 30 * DAY;
    const recent = reports.filter((r) => r.status !== 'rejected' && Date.parse(r.occurred_at) >= since);

    const byStreet = new Map();
    for (const r of recent) {
      const key = r.public_label.replace(/^\S+ block of /, '');
      byStreet.set(key, (byStreet.get(key) || 0) + 1);
    }
    const top = [...byStreet.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6);
    $('#hotspots').replaceChildren(...(top.length
      ? top.map(([street, n]) => h('li', null, street, ' — ', h('b', null, n)))
      : [h('li', { class: 'hint' }, 'No reports yet.')]));

    const hours = new Array(24).fill(0);
    for (const r of recent) hours[new Date(r.occurred_at).getHours()]++;
    const max = Math.max(1, ...hours);
    $('#hours').replaceChildren(...hours.map((n, i) => {
      const bar = h('span', { title: `${String(i).padStart(2, '0')}:00 — ${n} report${n === 1 ? '' : 's'}` });
      bar.style.height = `${(n / max) * 100}%`;
      return bar;
    }));
  }

  // ------------------------------------------------------------ table

  function filtered() {
    const status = $('#status-filter').value;
    const q = $('#search').value.trim().toLowerCase();
    return reports.filter((r) => {
      if (status === '' && r.status === 'rejected') return false;
      if (status && status !== '*' && r.status !== status) return false;
      if (!q) return true;
      return [r.address, r.public_label, r.details, r.police_report_no, r.contact]
        .some((v) => (v || '').toLowerCase().includes(q));
    });
  }

  async function setStatus(r, status, row) {
    try {
      await api(`/api/admin/reports/${r.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status }),
      });
      r.status = status;
      row.className = `status-${status}${status === 'rejected' ? ' is-rejected' : ''}`;
      const m = markers.get(r.id);
      if (m) m.setStyle({ fillColor: STATUS_COLORS[status] });
      renderInsights();
      toast(`Report #${r.id} marked “${STATUS_LABELS[status]}”.`);
    } catch (ex) {
      toast(ex.message);
    }
  }

  async function deleteReport(r) {
    const ok = window.confirm(
      `Permanently delete report #${r.id} (${r.address})?\n\n` +
      'This removes it from the map, the admin list and future CSV exports. It can’t be undone. ' +
      'To just hide it from the public map, set its status to Rejected instead.');
    if (!ok) return;
    try {
      await api(`/api/admin/reports/${r.id}`, { method: 'DELETE' });
      reports = reports.filter((x) => x.id !== r.id);
      render();
      toast(`Report #${r.id} deleted.`);
    } catch (ex) {
      toast(ex.message);
    }
  }

  function render() {
    const rows = filtered();
    $('#count').textContent = `${rows.length} report${rows.length === 1 ? '' : 's'}`;
    const tbody = $('#rows');
    tbody.replaceChildren();
    for (const r of rows) {
      const tr = h('tr', { class: `status-${r.status}${r.status === 'rejected' ? ' is-rejected' : ''}` });
      const select = h('select', { 'aria-label': `Status of report ${r.id}` },
        Object.entries(STATUS_LABELS).map(([v, label]) =>
          h('option', { value: v, selected: v === r.status }, label)));
      select.addEventListener('change', () => setStatus(r, select.value, tr));

      const osm = `https://www.openstreetmap.org/?mlat=${r.lat}&mlon=${r.lng}#map=18/${r.lat}/${r.lng}`;
      tr.append(
        h('td', { class: 'nowrap' }, fmt(r.occurred_at)),
        h('td', null,
          h('div', { class: 'addr' }, r.address),
          h('div', { class: 'sub' },
            h('a', { href: '#admin-map', onclick: (e) => { e.preventDefault(); focusOnMap(r); } }, 'Show on map'),
            ' · ',
            h('a', { href: osm, target: '_blank', rel: 'noopener noreferrer' }, 'OpenStreetMap ↗'),
            ' · #', String(r.id))),
        h('td', null, r.people || '—'),
        h('td', null, r.damage ? 'Yes' : 'No'),
        h('td', null, r.footage ? 'Yes' : 'No'),
        h('td', null, r.police_report_no || '—'),
        h('td', { class: 'details' }, r.details || '—'),
        h('td', null, r.contact || '—'),
        h('td', { class: 'nowrap' }, fmt(r.created_at)),
        h('td', { class: 'nowrap' }, select,
          h('button', { class: 'link-btn danger', type: 'button', onclick: () => deleteReport(r) }, 'Delete')));
      tbody.append(tr);
    }
    if (!rows.length) {
      tbody.append(h('tr', null, h('td', { colspan: '10', class: 'hint' }, 'No reports match.')));
    }
    renderMap(rows);
    renderInsights();
  }

  function focusOnMap(r) {
    $('#admin-map').scrollIntoView({ behavior: 'smooth', block: 'center' });
    map.flyTo([r.lat, r.lng], 17, { duration: 0.5 });
    const m = markers.get(r.id);
    if (m) map.once('moveend', () => m.openPopup());
  }

  $('#status-filter').addEventListener('change', render);
  $('#search').addEventListener('input', render);

  $('#export').addEventListener('click', async () => {
    try {
      const all = ['*', 'rejected'].includes($('#status-filter').value) ? '?include_rejected=1' : '';
      const res = await api(`/api/admin/export.csv${all}`);
      const blob = await res.blob();
      const name = (res.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/);
      const a = h('a', { href: URL.createObjectURL(blob), download: name ? name[1] : 'door-kick-reports.csv' });
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    } catch (ex) {
      toast(ex.message);
    }
  });

  // ------------------------------------------------------------ start

  const saved = store.get();
  if (saved) signIn(saved).catch(() => showDashboard(false));
  else showDashboard(false);
})();
