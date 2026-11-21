// Trips list view
import { api } from '../api.js';
import { formatDateTime, formatKm, formatDuration, tripTypeBadge, statusBadge, truncateAddress, escapeHtml, haversineDistance } from '../utils.js';
import { renderFilters, attachFilterEvents } from '../components/filters.js';
import { renderPagination } from '../components/pagination.js';
import { showToast } from '../components/toast.js';
import { updateUnconfirmedBadge } from '../components/navbar.js';
import { showModal, closeModal } from '../components/modal.js';

let state = {
    trips: [],
    total: 0,
    limit: 50,
    offset: 0,
    filters: {},
    vehicles: [],
    drivers: [],
    purposeTemplates: [],
    selectedTrips: new Set(),
    focusedRow: -1
};

export async function renderTrips() {
    const content = document.getElementById('content');
    document.getElementById('page-title').textContent = 'Jazdy';
    document.getElementById('top-actions').innerHTML = `
        <button class="btn btn-outline btn-sm" id="btn-recalc-km" title="Prepočítať vzdialenosti cez Google Routes"><span>&#128207;</span> <span>Prepočítať km</span></button>
        <button class="btn btn-outline btn-sm" id="btn-import"><span>&#128229;</span> <span>Import</span></button>
    `;

    // Parse URL params
    const urlParams = new URLSearchParams(location.hash.split('?')[1] || '');
    if (urlParams.get('status')) state.filters.status = urlParams.get('status');

    content.innerHTML = '<div class="loading"><div class="spinner"></div> Načítavam...</div>';

    try {
        state.vehicles = await api.getVehicles();
    } catch (e) {
        state.vehicles = [];
    }
    try {
        state.purposeTemplates = await api.getPurposeTemplates();
    } catch (e) {
        state.purposeTemplates = [];
    }
    try {
        state.drivers = await api.getDrivers();
    } catch (e) {
        state.drivers = [];
    }

    await loadTrips();

    document.getElementById('btn-import')?.addEventListener('click', async () => {
        showToast('Importujem jazdy...', 'info');
        try {
            const result = await api.importTrips();
            showToast(`Import: ${result.inserted} nových jázd`, 'success');
            updateUnconfirmedBadge();
            await loadTrips();
        } catch (e) {
            showToast('Chyba: ' + e.message, 'error');
        }
    });

    document.getElementById('btn-recalc-km')?.addEventListener('click', async () => {
        // If specific trips selected, recalculate only those
        const tripIds = state.selectedTrips.size > 0 ? [...state.selectedTrips] : null;
        const label = tripIds ? `${tripIds.length} vybraných jázd` : 'všetkých jázd';
        showToast(`Prepočítavam km pre ${label}...`, 'info');
        try {
            const result = await api.recalculateDistances(tripIds);
            const details = result.details || [];
            const changed = details.filter(d => d.old_km !== d.new_km);
            showToast(`Prepočítané: ${result.recalculated} jázd, ${changed.length} zmenených`, 'success');
            await loadTrips();
        } catch (e) {
            showToast('Chyba: ' + e.message, 'error');
        }
    });
}

async function loadTrips() {
    const content = document.getElementById('content');

    try {
        const params = {
            ...state.filters,
            limit: state.limit,
            offset: state.offset
        };

        const result = await api.getTrips(params);
        state.trips = result.trips || [];
        state.total = result.total || 0;
        state.selectedTrips.clear();

        renderTripsList();
    } catch (err) {
        content.innerHTML = `<div class="alert alert-danger">Chyba: ${err.message}</div>`;
    }
}

function renderTripsList() {
    const content = document.getElementById('content');
    state._gaps = [];

    const filtersHtml = renderFilters({
        vehicles: state.vehicles,
        currentFilters: state.filters,
        onFilter: () => {}
    });

    const hasSelected = state.selectedTrips.size > 0;

    content.innerHTML = `
        ${filtersHtml}
        ${hasSelected ? renderBulkActions() : ''}
        <div class="table-wrapper">
            <table id="trips-table">
                <thead>
                    <tr>
                        <th><input type="checkbox" id="select-all"></th>
                        <th>Dátum</th>
                        <th>Odkiaľ</th>
                        <th>Kam</th>
                        <th>Stav km</th>
                        <th>Vzdialenosť</th>
                        <th>Trvanie</th>
                        <th>Typ</th>
                        <th>Stav</th>
                        <th>Akcie</th>
                    </tr>
                </thead>
                <tbody>
                    ${state.trips.length === 0 ? `
                        <tr><td colspan="10" class="empty-state">
                            <div class="icon">&#128663;</div>
                            <h3>Žiadne jazdy</h3>
                            <p>Importujte jazdy z Traccar alebo vytvorte manuálne.</p>
                        </td></tr>
                    ` : renderTripsWithGaps(state.trips)}
                </tbody>
            </table>
        </div>
        <div id="pagination-container">
            ${renderPagination(state.total, state.limit, state.offset, handlePageChange)}
        </div>
        <div style="margin-top:8px;font-size:11px;color:var(--text-muted)">
            Klávesy: <kbd class="kbd">j</kbd>/<kbd class="kbd">k</kbd> navigácia, <kbd class="kbd">b</kbd> služobná, <kbd class="kbd">p</kbd> súkromná, <kbd class="kbd">Enter</kbd> detail
        </div>
    `;

    attachFilterEvents((filters) => {
        state.filters = filters;
        state.offset = 0;
        loadTrips();
    });

    attachTableEvents();
    attachKeyboardShortcuts();
}

function renderTripsWithGaps(trips) {
    // Trips are sorted by start_time ASC (morning first)
    let html = '';
    for (let idx = 0; idx < trips.length; idx++) {
        const trip = trips[idx];
        const nextTrip = trips[idx + 1]; // next in display = later in time

        html += renderTripRow(trip, idx);

        // Show gap between this trip's end and next trip's start
        if (nextTrip) {
            const thisEnd = new Date(trip.end_time);
            const nextStart = new Date(nextTrip.start_time);
            const gapMs = nextStart - thisEnd;

            if (gapMs > 300000 && gapMs < 24 * 3600 * 1000) { // gap > 5 min and < 24h
                const gapMin = Math.round(gapMs / 60000);
                const fromAddr = (trip.end_address || '?').split(',')[0];
                const toAddr = (nextTrip.start_address || '?').split(',')[0];

                // Calculate GPS distance between end of this trip and start of next
                const prevEndLat = parseFloat(trip.end_latitude);
                const prevEndLon = parseFloat(trip.end_longitude);
                const thisStartLat = parseFloat(nextTrip.start_latitude);
                const thisStartLon = parseFloat(nextTrip.start_longitude);

                let gapDistM = 0;
                if (!isNaN(prevEndLat) && !isNaN(thisStartLat)) {
                    gapDistM = haversineDistance(prevEndLat, prevEndLon, thisStartLat, thisStartLon);
                }

                const isSamePlace = gapDistM < 1000; // < 1km = same place
                const isMissingTrip = gapDistM >= 1000; // >= 1km = likely missing trip

                if (isSamePlace) {
                    html += `<tr class="gap-row">
                        <td colspan="9">
                            <span class="gap-indicator">
                                &#9654; Zastavenie ${gapMin} min (${fromAddr})
                            </span>
                        </td>
                    </tr>`;
                } else {
                    const gapDistKm = (gapDistM / 1000).toFixed(1);
                    const gapIdx = state._gaps ? state._gaps.length : 0;
                    if (!state._gaps) state._gaps = [];
                    state._gaps.push({
                        vehicle_id: trip.vehicle_id || nextTrip.vehicle_id,
                        start_time: trip.end_time,
                        end_time: nextTrip.start_time,
                        start_latitude: prevEndLat,
                        start_longitude: prevEndLon,
                        end_latitude: thisStartLat,
                        end_longitude: thisStartLon,
                        start_address: trip.end_address || '',
                        end_address: nextTrip.start_address || '',
                        distance_meters: Math.round(gapDistM)
                    });

                    html += `<tr class="gap-row gap-missing">
                        <td colspan="9">
                            <span class="gap-indicator gap-warning">
                                &#9888; Chýbajúca jazda ${gapMin} min (~${gapDistKm} km): ${escapeHtml(fromAddr)} &#8594; ${escapeHtml(toAddr)}
                                <button class="btn btn-sm btn-outline btn-create-gap-trip" data-gap-idx="${gapIdx}" style="margin-left:8px;font-size:11px">
                                    + Vytvoriť jazdu
                                </button>
                            </span>
                        </td>
                    </tr>`;
                }
            }
        }
    }
    return html;
}

function renderTripRow(trip, idx) {
    const isSelected = state.selectedTrips.has(trip.id);
    const isParking = trip.is_parking;
    return `
        <tr data-id="${trip.id}" data-status="${trip.status}" data-idx="${idx}" class="${isSelected ? 'selected' : ''} ${isParking ? 'parking-row' : ''}">
            <td><input type="checkbox" class="trip-checkbox" data-id="${trip.id}" ${isSelected ? 'checked' : ''}></td>
            <td>
                <a href="#/trips/${trip.id}">${formatDateTime(trip.start_time)}</a>
                ${isParking ? ' <span class="badge badge-parking" title="Zastavenie (GPS drift)">P</span>' : ''}
            </td>
            <td title="${escapeHtml(trip.start_address)}">${truncateAddress(trip.start_address, 25)}</td>
            <td title="${escapeHtml(trip.end_address)}">${truncateAddress(trip.end_address, 25)}</td>
            <td class="odometer-cell">${trip.start_odometer != null ? `${parseFloat(trip.start_odometer).toFixed(1)}` : '-'} → ${trip.end_odometer != null ? `${parseFloat(trip.end_odometer).toFixed(1)}` : '-'}</td>
            <td>${formatKm(trip.distance_meters)}</td>
            <td>${formatDuration(trip.duration_seconds)}</td>
            <td>
                <div class="type-select">
                    <button class="type-btn business ${trip.trip_type === 'business' ? 'active' : ''}" data-id="${trip.id}" data-type="business" title="Služobná">S</button>
                    <button class="type-btn private ${trip.trip_type === 'private' ? 'active' : ''}" data-id="${trip.id}" data-type="private" title="Privátna">P</button>
                </div>
            </td>
            <td>${statusBadge(trip.status)}</td>
            <td>
                <a href="#/trips/${trip.id}" class="btn btn-outline btn-sm btn-icon" title="Detail">&#128065;</a>
                ${trip.status === 'UNCONFIRMED' ? `<button class="btn btn-success btn-sm btn-icon btn-confirm" data-id="${trip.id}" title="Potvrdiť">&#10004;</button>` : ''}
            </td>
        </tr>
    `;
}

function renderBulkActions() {
    const purposeOptions = state.purposeTemplates
        .map(t => `<option value="${escapeHtml(t.label)}">${escapeHtml(t.label)}</option>`)
        .join('');
    const driverOptions = state.drivers
        .map(d => `<option value="${d.id}">${escapeHtml(d.first_name + ' ' + d.last_name)}</option>`)
        .join('');

    return `
        <div class="alert alert-info" id="bulk-actions" style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:space-between">
            <span style="font-weight:600">${state.selectedTrips.size} jazdy vybrané</span>
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
                <select class="form-control" id="bulk-type-select" style="width:auto;padding:4px 8px;font-size:13px">
                    <option value="">-- Typ --</option>
                    <option value="business">Služobná</option>
                    <option value="private">Privátna</option>
                </select>
                <select class="form-control" id="bulk-purpose-select" style="width:auto;padding:4px 8px;font-size:13px">
                    <option value="">-- Účel --</option>
                    ${purposeOptions}
                </select>
                <select class="form-control" id="bulk-driver-select" style="width:auto;padding:4px 8px;font-size:13px">
                    <option value="">-- Vodič --</option>
                    ${driverOptions}
                </select>
                <button class="btn btn-primary btn-sm" id="bulk-apply">Použiť</button>
                <span style="border-left:1px solid #ccc;height:24px"></span>
                <button class="btn btn-success btn-sm" id="bulk-confirm">&#10004; Potvrdiť</button>
            </div>
        </div>
    `;
}

function attachTableEvents() {
    // Select all checkbox
    document.getElementById('select-all')?.addEventListener('change', (e) => {
        const checked = e.target.checked;
        state.trips.forEach(t => {
            if (checked) state.selectedTrips.add(t.id);
            else state.selectedTrips.delete(t.id);
        });
        renderTripsList();
    });

    // Individual checkboxes
    document.querySelectorAll('.trip-checkbox').forEach(cb => {
        cb.addEventListener('change', (e) => {
            const id = parseInt(e.target.dataset.id);
            if (e.target.checked) state.selectedTrips.add(id);
            else state.selectedTrips.delete(id);
            renderTripsList();
        });
    });

    // Type buttons (inline classification)
    document.querySelectorAll('.type-btn').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const id = parseInt(btn.dataset.id);
            const type = btn.dataset.type;
            try {
                await api.updateTrip(id, { trip_type: type });
                const trip = state.trips.find(t => t.id === id);
                if (trip) trip.trip_type = type;
                // Update just the row
                const row = document.querySelector(`tr[data-id="${id}"]`);
                if (row) {
                    row.querySelectorAll('.type-btn').forEach(b => b.classList.remove('active'));
                    btn.classList.add('active');
                }
                showToast('Typ jazdy aktualizovaný', 'success');
            } catch (e) {
                showToast('Chyba: ' + e.message, 'error');
            }
        });
    });

    // Quick confirm buttons
    document.querySelectorAll('.btn-confirm').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.preventDefault();
            const id = parseInt(btn.dataset.id);
            try {
                await api.confirmTrip(id, {});
                showToast('Jazda potvrdená', 'success');
                updateUnconfirmedBadge();
                await loadTrips();
            } catch (e) {
                showToast('Chyba: ' + e.message, 'error');
            }
        });
    });

    // Gap trip creation buttons
    document.querySelectorAll('.btn-create-gap-trip').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.preventDefault();
            const gapIdx = parseInt(btn.dataset.gapIdx);
            const gapData = state._gaps?.[gapIdx];
            if (gapData) showCreateGapTripModal(gapData);
        });
    });

    // Bulk apply (type + purpose + driver)
    document.getElementById('bulk-apply')?.addEventListener('click', async () => {
        const tripType = document.getElementById('bulk-type-select')?.value;
        const purpose = document.getElementById('bulk-purpose-select')?.value;
        const driverId = document.getElementById('bulk-driver-select')?.value;

        if (!tripType && !purpose && !driverId) {
            showToast('Vyberte typ, účel alebo vodiča', 'warning');
            return;
        }

        try {
            const ids = Array.from(state.selectedTrips);
            const data = {};
            if (tripType) data.trip_type = tripType;
            if (purpose) data.trip_purpose = purpose;
            if (driverId) data.driver_id = parseInt(driverId);
            const result = await api.bulkUpdate(ids, data);
            showToast(`${result.updated} jázd aktualizovaných`, 'success');
            await loadTrips();
        } catch (e) {
            showToast('Chyba: ' + e.message, 'error');
        }
    });

    // Bulk confirm (includes driver/type/purpose from dropdowns)
    document.getElementById('bulk-confirm')?.addEventListener('click', async () => {
        const driverId = document.getElementById('bulk-driver-select')?.value;
        const tripType = document.getElementById('bulk-type-select')?.value;
        const purpose = document.getElementById('bulk-purpose-select')?.value;

        if (!driverId) {
            showToast('Vyberte vodiča pred potvrdením', 'warning');
            return;
        }

        try {
            const ids = Array.from(state.selectedTrips);
            const body = { trip_ids: ids, driver_id: parseInt(driverId) };
            if (tripType) body.trip_type = tripType;
            if (purpose) body.trip_purpose = purpose;
            const result = await api.bulkConfirmWithData(ids, body);
            showToast(`${result.confirmed} jázd potvrdených`, 'success');
            if (result.errors?.length) {
                result.errors.forEach(e => showToast(e, 'warning'));
            }
            updateUnconfirmedBadge();
            await loadTrips();
        } catch (e) {
            showToast('Chyba: ' + e.message, 'error');
        }
    });
}

function handlePageChange(newOffset) {
    state.offset = newOffset;
    loadTrips();
}

function attachKeyboardShortcuts() {
    const handler = (e) => {
        // Skip if typing in input
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

        const rows = document.querySelectorAll('#trips-table tbody tr[data-id]');
        if (!rows.length) return;

        if (e.key === 'j') {
            state.focusedRow = Math.min(state.focusedRow + 1, rows.length - 1);
            highlightRow(rows);
        } else if (e.key === 'k') {
            state.focusedRow = Math.max(state.focusedRow - 1, 0);
            highlightRow(rows);
        } else if (e.key === 'Enter' && state.focusedRow >= 0) {
            const id = rows[state.focusedRow]?.dataset.id;
            if (id) location.hash = `#/trips/${id}`;
        } else if (['b', 'p'].includes(e.key) && state.focusedRow >= 0) {
            const types = { b: 'business', p: 'private' };
            const id = parseInt(rows[state.focusedRow]?.dataset.id);
            if (id) {
                api.updateTrip(id, { trip_type: types[e.key] }).then(() => {
                    showToast('Typ aktualizovaný', 'success');
                    loadTrips();
                }).catch(err => showToast(err.message, 'error'));
            }
        }
    };

    document.addEventListener('keydown', handler);
    // Clean up on route change
    window._tripsKeyHandler = handler;
}

function highlightRow(rows) {
    rows.forEach((row, i) => {
        row.style.outline = i === state.focusedRow ? '2px solid var(--primary)' : '';
        row.style.outlineOffset = i === state.focusedRow ? '-2px' : '';
    });
    if (rows[state.focusedRow]) {
        rows[state.focusedRow].scrollIntoView({ block: 'nearest' });
    }
}

function showCreateGapTripModal(gapData) {
    const distKm = (gapData.distance_meters / 1000).toFixed(1);
    const startTime = new Date(gapData.start_time);
    const endTime = new Date(gapData.end_time);
    const durationMin = Math.round((endTime - startTime) / 60000);

    const body = `
        <div style="margin-bottom:16px;padding:12px;background:var(--warning-bg, #fff3cd);border-radius:8px;font-size:13px">
            &#9888; Táto jazda nebola zaznamenaná GPS. Údaje sú odhadované na základe poslednej a nasledujúcej jazdy.
        </div>
        <form id="gap-trip-form">
            <div class="form-group">
                <label>Odkiaľ</label>
                <input type="text" class="form-control" id="gap-start-addr" value="${escapeHtml(gapData.start_address)}" readonly>
            </div>
            <div class="form-group">
                <label>Kam</label>
                <input type="text" class="form-control" id="gap-end-addr" value="${escapeHtml(gapData.end_address)}" readonly>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div class="form-group">
                    <label>Začiatok</label>
                    <input type="text" class="form-control" value="${formatDateTime(gapData.start_time)}" readonly>
                </div>
                <div class="form-group">
                    <label>Koniec</label>
                    <input type="text" class="form-control" value="${formatDateTime(gapData.end_time)}" readonly>
                </div>
            </div>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
                <div class="form-group">
                    <label>Vzdialenosť (km)</label>
                    <input type="number" class="form-control" id="gap-distance" value="${distKm}" step="0.1" min="0">
                </div>
                <div class="form-group">
                    <label>Trvanie</label>
                    <input type="text" class="form-control" value="${durationMin} min" readonly>
                </div>
            </div>
            <div class="form-group">
                <label>Typ jazdy</label>
                <select class="form-control" id="gap-trip-type">
                    <option value="unconfirmed">Nepotvrdená</option>
                    <option value="business">Služobná</option>
                    <option value="private">Privátna</option>
                </select>
            </div>
            <div class="form-group">
                <label>Poznámka</label>
                <input type="text" class="form-control" id="gap-notes" value="Manuálne vytvorená - chýbajúce GPS dáta" placeholder="Poznámka">
            </div>
        </form>
    `;

    const modal = showModal({
        title: 'Vytvoriť chýbajúcu jazdu',
        body,
        footer: `<button class="btn btn-outline" id="gap-cancel">Zrušiť</button>
                 <button class="btn btn-primary" id="gap-save">Vytvoriť jazdu</button>`
    });

    document.getElementById('gap-cancel')?.addEventListener('click', () => modal.close());

    document.getElementById('gap-save')?.addEventListener('click', async () => {
        try {
            const distanceKm = parseFloat(document.getElementById('gap-distance').value) || 0;
            const tripData = {
                vehicle_id: gapData.vehicle_id,
                start_time: gapData.start_time,
                end_time: gapData.end_time,
                start_latitude: gapData.start_latitude,
                start_longitude: gapData.start_longitude,
                end_latitude: gapData.end_latitude,
                end_longitude: gapData.end_longitude,
                start_address: gapData.start_address,
                end_address: gapData.end_address,
                distance_meters: Math.round(distanceKm * 1000),
                trip_type: document.getElementById('gap-trip-type').value,
                internal_notes: document.getElementById('gap-notes').value
            };

            await api.createTrip(tripData);
            modal.close();
            showToast('Jazda vytvorená', 'success');
            updateUnconfirmedBadge();
            await loadTrips();
        } catch (e) {
            showToast('Chyba: ' + e.message, 'error');
        }
    });
}
