(function () {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const HOUR = 3600e3;
  const DAY = 24 * HOUR;
  const NEAR_RADIUS_M = 1000;
  const LIST_LIMIT = 60;
  const REFRESH_MS = 2 * 60e3;

  const state = {
    days: 30,
    reports: [],
    markers: new Map(), // "lat,lng" -> Leaflet marker
    me: null,
    meLayer: null,
    fitted: false,
  };

  // ---------------------------------------------------------------- helpers

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

  async function api(path, opts) {
    const res = await fetch(path, opts);
    let body = null;
    try { body = await res.json(); } catch (_) { /* not JSON */ }
    if (!res.ok) throw new Error((body && body.error) || `Something went wrong (${res.status}).`);
    return body;
  }

  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  function relTime(ts) {
    const diff = ts - Date.now();
    const abs = Math.abs(diff);
    if (abs < HOUR) return rtf.format(Math.round(diff / 60e3), 'minute');
    if (abs < DAY) return rtf.format(Math.round(diff / HOUR), 'hour');
    if (abs < 30 * DAY) return rtf.format(Math.round(diff / DAY), 'day');
    return rtf.format(Math.round(diff / (30 * DAY)), 'month');
  }
  const dtf = new Intl.DateTimeFormat(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });
  const hourFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const fmtHour = (hr) => hourFmt.format(new Date(2000, 0, 1, hr));

  function ageClass(ts) {
    const age = Date.now() - ts;
    if (age <= DAY) return '24h';
    if (age <= 7 * DAY) return '7d';
    return 'old';
  }

  function chips(r) {
    const out = [];
    if (r.verified) out.push(h('span', { class: 'chip chip-verified' }, 'Verified'));
    if (r.damage) out.push(h('span', { class: 'chip chip-damage' }, 'Damage'));
    if (r.people) out.push(h('span', { class: 'chip' }, `${r.people} ${r.people === '1' ? 'person' : 'people'}`));
    if (r.footage) out.push(h('span', { class: 'chip' }, 'Has footage'));
    return out.length ? h('div', { class: 'chips' }, out) : null;
  }

  function toLocalInput(d) {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
  }

  function tiles() {
    return L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    });
  }

  // ---------------------------------------------------------------- main map

  const map = L.map('map', { worldCopyJump: true }).setView([39.8, -98.6], 4);
  tiles().addTo(map);
  const markerLayer = L.layerGroup().addTo(map);

  function groupReports(reports) {
    const groups = new Map();
    for (const r of reports) {
      r.ts = Date.parse(r.occurred_at);
      const key = `${r.lat},${r.lng}`;
      if (!groups.has(key)) groups.set(key, { key, lat: r.lat, lng: r.lng, label: r.label, reports: [] });
      groups.get(key).reports.push(r);
    }
    for (const g of groups.values()) g.reports.sort((a, b) => b.ts - a.ts);
    return [...groups.values()];
  }

  function popupContent(g) {
    const shown = g.reports.slice(0, 8);
    return h('div', null,
      h('div', { class: 'popup-title' }, g.label),
      h('ul', { class: 'popup-list' }, shown.map((r) =>
        h('li', null,
          h('div', null, h('strong', null, dtf.format(r.ts)), ' · ', relTime(r.ts)),
          chips(r)))),
      g.reports.length > shown.length
        ? h('div', { class: 'popup-more' }, `+ ${g.reports.length - shown.length} earlier reports here`)
        : null);
  }

  function renderMap() {
    markerLayer.clearLayers();
    state.markers.clear();
    for (const g of groupReports(state.reports)) {
      const n = g.reports.length;
      const cls = ageClass(g.reports[0].ts);
      const size = n > 1 ? Math.min(24 + Math.sqrt(n - 1) * 7, 48) : 18;
      const marker = L.marker([g.lat, g.lng], {
        icon: L.divIcon({ className: `pin pin-${cls}`, html: n > 1 ? String(n) : '', iconSize: [size, size] }),
        title: `${g.label} — ${n} report${n > 1 ? 's' : ''}`,
        alt: g.label,
        riseOnHover: true,
        zIndexOffset: cls === '24h' ? 1000 : cls === '7d' ? 500 : 0,
      });
      marker.bindPopup(() => popupContent(g), { maxWidth: 300 });
      marker.addTo(markerLayer);
      state.markers.set(g.key, marker);
    }
  }

  function renderList() {
    const list = $('#report-list');
    list.replaceChildren();
    const shown = state.reports.slice(0, LIST_LIMIT);
    for (const r of shown) {
      list.append(h('li', null,
        h('button', { class: 'report-item', type: 'button', onclick: () => focusReport(r) },
          h('i', { class: `dot dot-${ageClass(r.ts)}`, 'aria-hidden': 'true' }),
          h('span', null,
            h('span', { class: 'report-label' }, r.label),
            h('span', { class: 'report-time' }, `${dtf.format(r.ts)} · ${relTime(r.ts)}`),
            chips(r)))));
    }
    if (state.reports.length > LIST_LIMIT) {
      list.append(h('li', { class: 'empty' }, `Showing the latest ${LIST_LIMIT} of ${state.reports.length}. Zoom the map to see the rest.`));
    }
    $('#empty').hidden = state.reports.length > 0;
  }

  function renderStats() {
    const rs = state.reports;
    $('#stat-total').textContent = rs.length;
    $('#stat-24h').textContent = rs.filter((r) => Date.now() - r.ts <= DAY).length;
    const peak = $('#stat-peak');
    if (rs.length < 3) { peak.textContent = '–'; return; }
    const byHour = new Array(24).fill(0);
    for (const r of rs) byHour[new Date(r.ts).getHours()]++;
    let best = 0, bestCount = -1;
    for (let start = 0; start < 24; start++) {
      const c = byHour[start] + byHour[(start + 1) % 24] + byHour[(start + 2) % 24];
      if (c > bestCount) { best = start; bestCount = c; }
    }
    peak.textContent = `${fmtHour(best)} – ${fmtHour((best + 3) % 24)}`;
    peak.title = `${bestCount} of ${rs.length} reports happened in this 3-hour window`;
  }

  function focusReport(r) {
    const marker = state.markers.get(`${r.lat},${r.lng}`);
    map.flyTo([r.lat, r.lng], Math.max(map.getZoom(), 16), { duration: 0.6 });
    if (marker) map.once('moveend', () => marker.openPopup());
    if (window.matchMedia('(max-width: 820px)').matches) {
      document.getElementById('map').scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  async function load({ fit = false } = {}) {
    try {
      const data = await api(`/api/reports?days=${state.days}`);
      state.reports = data.reports;
      state.reports.forEach((r) => { r.ts = Date.parse(r.occurred_at); });
      renderMap();
      renderList();
      renderStats();
      updateNear();
      if (fit && state.reports.length) {
        const bounds = L.latLngBounds(state.reports.map((r) => [r.lat, r.lng]));
        map.fitBounds(bounds.pad(0.2), { maxZoom: 14 });
        state.fitted = true;
      }
    } catch (err) {
      toast(`Couldn’t load reports: ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- near me

  function updateNear() {
    const box = $('#near-summary');
    if (!state.me) { box.hidden = true; return; }
    const near = state.reports
      .filter((r) => map.distance(state.me, [r.lat, r.lng]) <= NEAR_RADIUS_M)
      .sort((a, b) => b.ts - a.ts);
    const period = $('#range').selectedOptions[0].textContent;
    box.replaceChildren(
      near.length
        ? h('span', null, h('strong', null, `${near.length} report${near.length > 1 ? 's' : ''}`),
            ` within 1 km (0.6 mi) of you in the ${period}. Most recent: ${relTime(near[0].ts)}.`)
        : h('span', null, `No reports within 1 km (0.6 mi) of you in the ${period}.`),
      h('br'),
      h('small', null, 'Your location stays on your device.'));
    box.hidden = false;
  }

  $('#near-me').addEventListener('click', () => {
    const btn = $('#near-me');
    if (!navigator.geolocation) { toast('Your browser can’t share your location.'); return; }
    btn.disabled = true;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        btn.disabled = false;
        state.me = L.latLng(pos.coords.latitude, pos.coords.longitude);
        if (state.meLayer) state.meLayer.remove();
        state.meLayer = L.layerGroup([
          L.circle(state.me, { radius: NEAR_RADIUS_M, color: '#2563eb', weight: 1.5, fillOpacity: 0.06, interactive: false }),
          L.circleMarker(state.me, { radius: 7, color: '#fff', weight: 2, fillColor: '#2563eb', fillOpacity: 1 }).bindTooltip('You are here'),
        ]).addTo(map);
        map.fitBounds(L.latLng(state.me).toBounds(NEAR_RADIUS_M * 2.4));
        updateNear();
      },
      () => {
        btn.disabled = false;
        toast('Couldn’t get your location. Check your browser’s location permission.');
      },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
  });

  $('#range').addEventListener('change', (e) => {
    state.days = Number(e.target.value);
    load();
  });

  // ---------------------------------------------------------------- report form

  const dlg = $('#report-dialog');
  const form = $('#report-form');
  const addressInput = $('#address');
  const hint = $('#pin-hint');
  const defaultHint = hint.innerHTML;
  let mini = null;
  let pin = null;
  let chosen = null; // { lat, lng, house_number, road, locality, postcode, origin }

  function setHint(text, ok) {
    hint.textContent = text;
    hint.classList.toggle('ok', !!ok);
  }

  function showFormError(msg) {
    const e = $('#form-error');
    e.textContent = msg;
    e.hidden = false;
    e.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function initMini() {
    mini = L.map('mini-map').setView(map.getCenter(), Math.max(map.getZoom(), 12));
    tiles().addTo(mini);
    mini.on('click', (e) => placePin(e.latlng, null));
  }

  function placePin(latlng, place) {
    latlng = L.latLng(latlng);
    if (!pin) {
      pin = L.marker(latlng, { draggable: true, autoPan: true, title: 'Drag to adjust' }).addTo(mini);
      pin.on('dragend', () => pinMoved(pin.getLatLng()));
    } else {
      pin.setLatLng(latlng);
    }
    if (place) {
      chosen = { ...place, origin: latlng };
    } else {
      pinMoved(latlng);
    }
  }

  function pinMoved(latlng) {
    // Small nudges keep the searched street name; a bigger move means the server looks it up again.
    if (chosen && chosen.origin && mini.distance(latlng, chosen.origin) <= 120) {
      chosen.lat = latlng.lat;
      chosen.lng = latlng.lng;
    } else {
      chosen = { lat: latlng.lat, lng: latlng.lng, house_number: '', road: '', locality: '', postcode: '', origin: null };
    }
    setHint('Pin placed. Drag it if it’s not quite right.', true);
  }

  function choosePlace(place) {
    $('#candidates').hidden = true;
    placePin([place.lat, place.lng], place);
    mini.setView([place.lat, place.lng], 17);
    setHint(`Found: ${place.label}. Drag the pin if it’s not quite right.`, true);
  }

  async function findAddress() {
    $('#form-error').hidden = true;
    const q = addressInput.value.trim();
    if (q.length < 4) { showFormError('Type the street address first, including the city.'); return; }
    const btn = $('#find-address');
    btn.disabled = true;
    btn.textContent = 'Searching…';
    try {
      const { results } = await api(`/api/geocode?q=${encodeURIComponent(q)}`);
      const list = $('#candidates');
      if (!results.length) {
        list.hidden = true;
        setHint('No match found. Check the spelling, add the city, or click the map to place the pin.');
      } else if (results.length === 1) {
        choosePlace(results[0]);
      } else {
        list.replaceChildren(...results.map((p) =>
          h('li', null, h('button', { type: 'button', onclick: () => choosePlace(p) }, p.label))));
        list.hidden = false;
        setHint('Several matches — pick the right one.');
      }
    } catch (err) {
      setHint(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Find';
    }
  }

  function resetForm() {
    form.reset();
    chosen = null;
    if (pin) { pin.remove(); pin = null; }
    $('#candidates').hidden = true;
    $('#form-error').hidden = true;
    hint.innerHTML = defaultHint;
    hint.classList.remove('ok');
  }

  function openReport() {
    const now = toLocalInput(new Date());
    const occ = $('#occurred');
    occ.max = now;
    if (!occ.value) occ.value = now;
    dlg.showModal();
    if (!mini) initMini();
    requestAnimationFrame(() => mini.invalidateSize());
    addressInput.focus();
  }

  $('#open-report').addEventListener('click', openReport);
  $('#close-report').addEventListener('click', () => dlg.close());
  $('#cancel-report').addEventListener('click', () => dlg.close());
  $('#find-address').addEventListener('click', findAddress);
  addressInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); findAddress(); }
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    $('#form-error').hidden = true;

    const address = addressInput.value.trim();
    if (!address) return showFormError('Please enter the address where it happened.');
    if (!chosen) return showFormError('Press Find to locate the address, or click the map to place the pin.');
    const occValue = $('#occurred').value;
    const when = occValue ? new Date(occValue) : null;
    if (!when || Number.isNaN(when.getTime())) return showFormError('Please enter when it happened.');
    if (when.getTime() > Date.now() + 10 * 60e3) return showFormError('The date and time can’t be in the future.');
    if (!$('#confirm').checked) return showFormError('Please confirm the report is accurate.');

    const payload = {
      address,
      occurred_at: when.toISOString(),
      lat: chosen.lat,
      lng: chosen.lng,
      house_number: chosen.house_number || '',
      road: chosen.road || '',
      locality: chosen.locality || '',
      postcode: chosen.postcode || '',
      people: $('#people').value,
      damage: $('#damage').checked,
      footage: $('#footage').checked,
      police_report_no: $('#police-no').value.trim(),
      details: $('#details').value.trim(),
      contact: $('#contact').value.trim(),
      website: $('#website').value,
      confirm: true,
    };

    const btn = $('#submit-report');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
      const res = await api('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      dlg.close();
      resetForm();
      toast('Thank you — your report is on the map.');
      if (when.getTime() < Date.now() - state.days * DAY) {
        state.days = 365;
        $('#range').value = '365';
      }
      await load();
      if (res && res.lat != null) {
        map.flyTo([res.lat, res.lng], 16, { duration: 0.6 });
        const marker = state.markers.get(`${res.lat},${res.lng}`);
        if (marker) map.once('moveend', () => marker.openPopup());
      }
    } catch (err) {
      showFormError(err.message);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Submit report';
    }
  });

  // ---------------------------------------------------------------- start

  (async function start() {
    try {
      const cfg = await api('/api/config');
      if (cfg.site_name) {
        document.title = cfg.site_name;
        $('#site-name').textContent = cfg.site_name;
      }
      if (cfg.center) map.setView(cfg.center, cfg.zoom || 4);
    } catch (_) { /* keep defaults */ }
    await load({ fit: true });
    setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
  })();
})();
