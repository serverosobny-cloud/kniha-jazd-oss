// Settings view - Geofence zones, classification rules, import, device sync
import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showModal } from '../components/modal.js';
import { escapeHtml, formatDateTime } from '../utils.js';

let settingsMap = null;
let mapsApiKey = null;

function loadGoogleMaps(apiKey) {
    return new Promise((resolve, reject) => {
        if (window.google?.maps) { resolve(); return; }
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,marker`;
        script.async = true;
        script.onload = resolve;
        script.onerror = () => reject(new Error('Google Maps sa nepodarilo načítať'));
        document.head.appendChild(script);
    });
}

async function ensureGoogleMaps() {
    if (window.google?.maps) return true;
    if (!mapsApiKey) {
        try {
            const result = await api.getPlacesApiKey();
            mapsApiKey = result.key;
        } catch (e) { return false; }
    }
    try {
        await loadGoogleMaps(mapsApiKey);
        return true;
    } catch (e) { return false; }
}

/**
 * Parse coordinates - supports:
 * - Decimal: 48.148600
 * - DMS: 48°08'55.0"N or 48°08'55.0"
 * - Google Maps: 48.148600, 17.107700
 */
function parseCoordinate(str) {
    if (!str) return NaN;
    str = str.trim();

    // Already a number
    const num = parseFloat(str);
    if (!isNaN(num) && /^-?\d+\.?\d*$/.test(str)) return num;

    // DMS format: 48°08'55.0"N or 48°08'55.0"
    const dmsRegex = /(-?\d+)[°]\s*(\d+)[''′]\s*([\d.]+)[""″]?\s*([NSEW])?/i;
    const match = str.match(dmsRegex);
    if (match) {
        const deg = parseFloat(match[1]);
        const min = parseFloat(match[2]);
        const sec = parseFloat(match[3]);
        const dir = (match[4] || '').toUpperCase();
        let result = Math.abs(deg) + min / 60 + sec / 3600;
        if (dir === 'S' || dir === 'W' || deg < 0) result = -result;
        return result;
    }

    return parseFloat(str);
}

/**
 * Parse a combined coordinate string like "48°08'55.0"N 17°06'27.7"E"
 * or "48.148600, 17.107700"
 */
function parseCoordsFromString(str) {
    if (!str) return null;
    str = str.trim();

    // Try "lat, lon" format (Google Maps style)
    const commaMatch = str.match(/^(-?\d+\.?\d*)\s*,\s*(-?\d+\.?\d*)$/);
    if (commaMatch) {
        return { lat: parseFloat(commaMatch[1]), lon: parseFloat(commaMatch[2]) };
    }

    // Try two DMS values
    const dmsAll = [...str.matchAll(/(-?\d+)[°]\s*(\d+)[''′]\s*([\d.]+)[""″]?\s*([NSEW])?/gi)];
    if (dmsAll.length === 2) {
        const lat = parseCoordinate(dmsAll[0][0]);
        const lon = parseCoordinate(dmsAll[1][0]);
        if (!isNaN(lat) && !isNaN(lon)) return { lat, lon };
    }

    return null;
}

export async function renderSettings() {
    const content = document.getElementById('content');
    document.getElementById('page-title').textContent = 'Nastavenia';
    document.getElementById('top-actions').innerHTML = '';

    content.innerHTML = '<div class="loading"><div class="spinner"></div> Načítavam...</div>';

    try {
        const [zones, rules, importHistory] = await Promise.all([
            api.getZones(),
            api.getRules(),
            api.getImportHistory(10)
        ]);

        content.innerHTML = `
            <div style="display:flex;gap:8px;margin-bottom:24px;flex-wrap:wrap">
                <button class="btn btn-outline ${activeTab === 'zones' ? 'btn-primary' : ''}" data-tab="zones">Geofence zóny</button>
                <button class="btn btn-outline ${activeTab === 'rules' ? 'btn-primary' : ''}" data-tab="rules">Klasifikačné pravidlá</button>
                <button class="btn btn-outline ${activeTab === 'import' ? 'btn-primary' : ''}" data-tab="import">Import</button>
            </div>
            <div id="settings-content"></div>
        `;

        document.querySelectorAll('[data-tab]').forEach(btn => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                renderSettings();
            });
        });

        const sc = document.getElementById('settings-content');
        if (activeTab === 'zones') renderZones(sc, zones);
        else if (activeTab === 'rules') renderRules(sc, zones, rules);
        else if (activeTab === 'import') renderImport(sc, importHistory);

    } catch (err) {
        content.innerHTML = `<div class="alert alert-danger">Chyba: ${err.message}</div>`;
    }
}

let activeTab = 'zones';

function renderZones(container, zones) {
    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3>Geofence zóny (${zones.length})</h3>
                <button class="btn btn-primary btn-sm" id="btn-add-zone">+ Pridať zónu</button>
            </div>
            <div id="zones-map" class="map-container" style="margin-bottom:16px"></div>
            ${zones.length === 0 ? '<p style="color:var(--text-muted)">Žiadne zóny. Pridajte prvú.</p>' : `
                <div class="zone-list">
                    ${zones.map(z => `
                        <div class="zone-card">
                            <h4>
                                ${escapeHtml(z.name)}
                                <span class="zone-type ${z.zone_type}">${zoneTypeLabel(z.zone_type)}</span>
                            </h4>
                            <div style="font-size:12px;color:var(--text-muted)">
                                ${parseFloat(z.latitude)?.toFixed(5)}, ${parseFloat(z.longitude)?.toFixed(5)} (r: ${z.radius_meters || 200}m)
                            </div>
                            ${z.address ? `<div style="font-size:12px;color:var(--text-muted)">${escapeHtml(z.address)}</div>` : ''}
                            <div style="display:flex;gap:8px;margin-top:4px">
                                <button class="btn btn-outline btn-sm btn-edit-zone" data-id="${z.id}">Upraviť</button>
                                <button class="btn btn-danger btn-sm btn-delete-zone" data-id="${z.id}">Zmazať</button>
                            </div>
                        </div>
                    `).join('')}
                </div>
            `}
        </div>
    `;

    initZonesMap(zones);

    document.getElementById('btn-add-zone')?.addEventListener('click', () => showZoneForm());

    document.querySelectorAll('.btn-edit-zone').forEach(btn => {
        btn.addEventListener('click', async () => {
            try {
                const zone = await api.getZone(btn.dataset.id);
                showZoneForm(zone);
            } catch (e) {
                showToast('Chyba: ' + e.message, 'error');
            }
        });
    });

    document.querySelectorAll('.btn-delete-zone').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Zmazať túto zónu?')) return;
            try {
                await api.deleteZone(btn.dataset.id);
                showToast('Zóna zmazaná', 'success');
                renderSettings();
            } catch (e) {
                showToast('Chyba: ' + e.message, 'error');
            }
        });
    });
}

async function initZonesMap(zones) {
    const container = document.getElementById('zones-map');
    if (!container) return;
    const ready = await ensureGoogleMaps();
    if (!ready) { container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">Google Maps nie je dostupný</div>'; return; }

    settingsMap = new google.maps.Map(container, {
        center: { lat: 48.1486, lng: 17.1077 },
        zoom: 10,
        mapTypeControl: false,
        streetViewControl: false,
        fullscreenControl: false
    });

    const colors = { home: '#2e7d32', office: '#1565c0', client: '#f57f17', warehouse: '#7b1fa2', other: '#616161' };
    const gmBounds = new google.maps.LatLngBounds();
    let hasPoints = false;

    zones.forEach(z => {
        const lat = parseFloat(z.latitude);
        const lon = parseFloat(z.longitude);
        if (lat && lon && !isNaN(lat) && !isNaN(lon)) {
            const color = colors[z.zone_type] || '#616161';
            const circle = new google.maps.Circle({
                center: { lat, lng: lon },
                radius: z.radius_meters || 200,
                strokeColor: color,
                strokeWeight: 2,
                fillColor: color,
                fillOpacity: 0.2,
                map: settingsMap
            });
            const infoWindow = new google.maps.InfoWindow({
                content: `<strong>${escapeHtml(z.name)}</strong><br>${zoneTypeLabel(z.zone_type)}`
            });
            circle.addListener('click', () => {
                infoWindow.setPosition({ lat, lng: lon });
                infoWindow.open(settingsMap);
            });
            gmBounds.extend({ lat, lng: lon });
            hasPoints = true;
        }
    });

    if (hasPoints) {
        settingsMap.fitBounds(gmBounds, { top: 30, bottom: 30, left: 30, right: 30 });
    }
}

function showZoneForm(zone = null) {
    const isEdit = !!zone;
    const body = document.createElement('div');
    body.innerHTML = `
        <form>
            <div class="form-group">
                <label>Názov</label>
                <input type="text" class="form-control" id="z-name" value="${escapeHtml(zone?.name || '')}" required>
            </div>
            <div class="form-group">
                <label>Typ</label>
                <select class="form-control" id="z-type">
                    <option value="home" ${zone?.zone_type === 'home' ? 'selected' : ''}>Domov</option>
                    <option value="office" ${zone?.zone_type === 'office' ? 'selected' : ''}>Kancelária</option>
                    <option value="client" ${zone?.zone_type === 'client' ? 'selected' : ''}>Klient</option>
                    <option value="warehouse" ${zone?.zone_type === 'warehouse' ? 'selected' : ''}>Sklad</option>
                    <option value="other" ${zone?.zone_type === 'other' ? 'selected' : ''}>Iné</option>
                </select>
            </div>
            <div class="form-group">
                <label>Súradnice</label>
                <input type="text" class="form-control" id="z-coords" placeholder="Kliknite na mapu alebo zadajte: 48.1486, 17.1077" value="${zone?.latitude ? parseFloat(zone.latitude).toFixed(6) + ', ' + parseFloat(zone.longitude).toFixed(6) : ''}">
                <p class="form-hint">Formáty: <strong>48.1486, 17.1077</strong> alebo <strong>48°08'55.0"N 17°06'27.7"E</strong> alebo kliknite na mapu</p>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Polomer (m)</label>
                    <input type="number" class="form-control" id="z-radius" value="${zone?.radius_meters || 200}">
                </div>
                <div class="form-group">
                    <label>Adresa</label>
                    <input type="text" class="form-control" id="z-address" value="${escapeHtml(zone?.address || '')}">
                </div>
            </div>
            <div id="zone-form-map" style="height:300px;border-radius:8px;overflow:hidden;border:1px solid #e0e0e0;margin-top:8px"></div>
            <p class="form-hint" style="margin-top:4px">Kliknite na mapu pre výber súradníc. Dvojklik pre priblíženie.</p>
        </form>
    `;

    const modal = showModal({
        title: isEdit ? 'Upraviť zónu' : 'Nová zóna',
        body,
        large: true,
        footer: `<button class="btn btn-outline" id="zone-cancel">Zrušiť</button><button class="btn btn-primary" id="zone-save">Uložiť</button>`
    });

    // Init mini map after modal is fully rendered
    let miniMap = null;
    let marker = null;
    let radiusCircle = null;

    setTimeout(async () => {
        const mapEl = document.getElementById('zone-form-map');
        if (!mapEl) return;
        const ready = await ensureGoogleMaps();
        if (!ready) { mapEl.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">Google Maps nie je dostupný</div>'; return; }

        const centerLat = parseFloat(zone?.latitude) || 48.1486;
        const centerLon = parseFloat(zone?.longitude) || 17.1077;

        miniMap = new google.maps.Map(mapEl, {
            center: { lat: centerLat, lng: centerLon },
            zoom: zone ? 14 : 10,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: false
        });

        if (zone?.latitude && zone?.longitude) {
            const zLat = parseFloat(zone.latitude);
            const zLon = parseFloat(zone.longitude);
            marker = new google.maps.Marker({ position: { lat: zLat, lng: zLon }, map: miniMap });
            if (zone.radius_meters) {
                radiusCircle = new google.maps.Circle({
                    center: { lat: zLat, lng: zLon },
                    radius: zone.radius_meters,
                    strokeColor: '#e74c3c',
                    strokeWeight: 1,
                    fillColor: '#e74c3c',
                    fillOpacity: 0.1,
                    map: miniMap
                });
            }
        }

        miniMap.addListener('click', (e) => {
            const lat = e.latLng.lat();
            const lon = e.latLng.lng();
            document.getElementById('z-coords').value = lat.toFixed(6) + ', ' + lon.toFixed(6);
            if (marker) marker.setMap(null);
            if (radiusCircle) radiusCircle.setMap(null);
            marker = new google.maps.Marker({ position: { lat, lng: lon }, map: miniMap });
        });
    }, 300);

    // Parse coordinate input on change
    const coordsInput = body.querySelector('#z-coords');
    coordsInput?.addEventListener('change', () => {
        const parsed = parseCoordsFromString(coordsInput.value);
        if (parsed && miniMap) {
            coordsInput.value = parsed.lat.toFixed(6) + ', ' + parsed.lon.toFixed(6);
            if (marker) marker.setMap(null);
            if (radiusCircle) radiusCircle.setMap(null);
            marker = new google.maps.Marker({ position: { lat: parsed.lat, lng: parsed.lon }, map: miniMap });
            miniMap.setCenter({ lat: parsed.lat, lng: parsed.lon });
            miniMap.setZoom(14);
        }
    });

    document.getElementById('zone-cancel')?.addEventListener('click', () => modal.close());
    document.getElementById('zone-save')?.addEventListener('click', async () => {
        const coordsVal = document.getElementById('z-coords').value;
        const parsed = parseCoordsFromString(coordsVal);

        if (!parsed || isNaN(parsed.lat) || isNaN(parsed.lon)) {
            showToast('Neplatné súradnice. Použite formát: 48.1486, 17.1077', 'warning');
            return;
        }

        const data = {
            name: document.getElementById('z-name').value,
            zone_type: document.getElementById('z-type').value,
            latitude: parsed.lat,
            longitude: parsed.lon,
            radius_meters: parseInt(document.getElementById('z-radius').value) || 200,
            address: document.getElementById('z-address').value
        };

        if (!data.name) {
            showToast('Vyplňte názov zóny', 'warning');
            return;
        }

        try {
            if (isEdit) {
                await api.updateZone(zone.id, data);
                showToast('Zóna aktualizovaná', 'success');
            } else {
                await api.createZone(data);
                showToast('Zóna vytvorená', 'success');
            }
            modal.close();
            renderSettings();
        } catch (e) {
            showToast('Chyba: ' + e.message, 'error');
        }
    });
}

function renderRules(container, zones, rules) {
    container.innerHTML = `
        <div class="card">
            <div class="card-header">
                <h3>Klasifikačné pravidlá (${rules.length})</h3>
                <button class="btn btn-primary btn-sm" id="btn-add-rule">+ Pridať pravidlo</button>
            </div>
            ${rules.length === 0 ? '<p style="color:var(--text-muted)">Žiadne pravidlá. Pridajte prvé.</p>' : `
                <table>
                    <thead><tr><th>Názov</th><th>Zo zóny</th><th>Do zóny</th><th>Typ</th><th>Účel</th><th></th></tr></thead>
                    <tbody>
                        ${rules.map(r => `
                            <tr>
                                <td>${escapeHtml(r.rule_name || '-')}</td>
                                <td>${escapeHtml(r.start_zone_name || 'Akákoľvek')}</td>
                                <td>${escapeHtml(r.end_zone_name || 'Akákoľvek')}</td>
                                <td><span class="badge badge-${r.suggested_trip_type}">${tripTypeLabel(r.suggested_trip_type)}</span></td>
                                <td style="font-size:12px">${escapeHtml(r.suggested_purpose || '-')}</td>
                                <td><button class="btn btn-danger btn-sm btn-delete-rule" data-id="${r.id}">Zmazať</button></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `}
        </div>
    `;

    function tripTypeLabel(t) {
        return { business: 'Služobná', private: 'Privátna' }[t] || t;
    }

    document.getElementById('btn-add-rule')?.addEventListener('click', () => showRuleForm(zones));

    document.querySelectorAll('.btn-delete-rule').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (!confirm('Zmazať pravidlo?')) return;
            try {
                await api.deleteRule(btn.dataset.id);
                showToast('Pravidlo zmazané', 'success');
                renderSettings();
            } catch (e) {
                showToast('Chyba: ' + e.message, 'error');
            }
        });
    });
}

function showRuleForm(zones) {
    const body = document.createElement('div');
    body.innerHTML = `
        <form>
            <div class="form-group">
                <label>Názov pravidla</label>
                <input type="text" class="form-control" id="r-name" placeholder="napr. Domov → Škôlka = Privátna">
            </div>
            <div class="form-group">
                <label>Zo zóny</label>
                <select class="form-control" id="r-start">
                    <option value="">Akákoľvek</option>
                    ${zones.map(z => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>Do zóny</label>
                <select class="form-control" id="r-end">
                    <option value="">Akákoľvek</option>
                    ${zones.map(z => `<option value="${z.id}">${escapeHtml(z.name)}</option>`).join('')}
                </select>
            </div>
            <div class="form-group">
                <label>Typ jazdy</label>
                <select class="form-control" id="r-type">
                    <option value="business">Služobná</option>
                    <option value="private">Privátna</option>
                </select>
            </div>
            <div class="form-group">
                <label>Účel jazdy (voliteľné)</label>
                <input type="text" class="form-control" id="r-purpose" placeholder="napr. deti">
            </div>
            <div class="form-group">
                <label>Priorita</label>
                <input type="number" class="form-control" id="r-priority" value="0">
                <p class="form-hint">Vyššia priorita = pravidlo má prednosť pri prekrytí</p>
            </div>
        </form>
    `;

    const modal = showModal({
        title: 'Nové pravidlo',
        body,
        footer: `<button class="btn btn-outline" id="rule-cancel">Zrušiť</button><button class="btn btn-primary" id="rule-save">Uložiť</button>`
    });

    // Auto-generate rule name from zone selections
    const autoName = () => {
        const startSel = body.querySelector('#r-start');
        const endSel = body.querySelector('#r-end');
        const typeSel = body.querySelector('#r-type');
        const nameInput = body.querySelector('#r-name');
        if (nameInput.value) return; // don't overwrite manual input
        const startName = startSel.selectedOptions[0]?.text || 'Akákoľvek';
        const endName = endSel.selectedOptions[0]?.text || 'Akákoľvek';
        const typeName = typeSel.selectedOptions[0]?.text || '';
        nameInput.value = `${startName} → ${endName} = ${typeName}`;
    };
    body.querySelector('#r-start')?.addEventListener('change', autoName);
    body.querySelector('#r-end')?.addEventListener('change', autoName);
    body.querySelector('#r-type')?.addEventListener('change', autoName);

    document.getElementById('rule-cancel')?.addEventListener('click', () => modal.close());
    document.getElementById('rule-save')?.addEventListener('click', async () => {
        const ruleName = document.getElementById('r-name').value;
        if (!ruleName) {
            showToast('Vyplňte názov pravidla', 'warning');
            return;
        }
        const data = {
            rule_name: ruleName,
            start_zone_id: document.getElementById('r-start').value || null,
            end_zone_id: document.getElementById('r-end').value || null,
            suggested_trip_type: document.getElementById('r-type').value,
            suggested_purpose: document.getElementById('r-purpose').value || null,
            priority: parseInt(document.getElementById('r-priority').value) || 0
        };

        try {
            await api.createRule(data);
            showToast('Pravidlo vytvorené', 'success');
            modal.close();
            renderSettings();
        } catch (e) {
            showToast('Chyba: ' + e.message, 'error');
        }
    });
}

function renderImport(container, history) {
    container.innerHTML = `
        <div class="card">
            <div class="card-header"><h3>Manuálny import</h3></div>
            <div class="form-row" style="margin-bottom:16px">
                <div class="form-group">
                    <label>Od</label>
                    <input type="datetime-local" class="form-control" id="import-from">
                </div>
                <div class="form-group">
                    <label>Do</label>
                    <input type="datetime-local" class="form-control" id="import-to">
                </div>
            </div>
            <div style="display:flex;gap:8px;margin-bottom:24px">
                <button class="btn btn-primary" id="btn-import-trips">Importovať jazdy</button>
                <button class="btn btn-outline" id="btn-sync-traccar">Synchronizovať zariadenia</button>
            </div>
        </div>
        <div class="card">
            <div class="card-header"><h3>História importov</h3></div>
            ${history.length === 0 ? '<p style="color:var(--text-muted)">Žiadna história</p>' : `
                <table>
                    <thead><tr><th>Čas</th><th>Typ</th><th>Stav</th><th>Spracované</th><th>Vložené</th><th>Chyby</th></tr></thead>
                    <tbody>
                        ${history.map(h => `
                            <tr>
                                <td>${formatDateTime(h.started_at)}</td>
                                <td>${escapeHtml(h.import_type)}</td>
                                <td><span class="badge ${h.status === 'completed' ? 'badge-confirmed' : h.status === 'running' ? 'badge-private' : 'badge-unconfirmed'}">${h.status}</span></td>
                                <td>${h.records_processed || 0}</td>
                                <td>${h.records_inserted || 0}</td>
                                <td>${h.errors || 0}</td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            `}
        </div>
    `;

    document.getElementById('btn-import-trips')?.addEventListener('click', async () => {
        const from = document.getElementById('import-from').value;
        const to = document.getElementById('import-to').value;
        try {
            showToast('Importujem jazdy...', 'info');
            const result = await api.importTrips({ from: from || undefined, to: to || undefined });
            showToast(`Import: ${result.inserted} nových, ${result.skipped} preskočených`, 'success');
            renderSettings();
        } catch (e) {
            showToast('Chyba: ' + e.message, 'error');
        }
    });

    document.getElementById('btn-sync-traccar')?.addEventListener('click', async () => {
        try {
            showToast('Synchronizujem...', 'info');
            await api.syncDevices();
            showToast('Zariadenia synchronizované', 'success');
        } catch (e) {
            showToast('Chyba: ' + e.message, 'error');
        }
    });
}

function zoneTypeLabel(type) {
    return { home: 'Domov', office: 'Kancelária', client: 'Klient', warehouse: 'Sklad', other: 'Iné' }[type] || type;
}
