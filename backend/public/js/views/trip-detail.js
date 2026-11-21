// Trip detail view
import { api } from '../api.js';
import { formatDateTime, formatKm, formatDuration, tripTypeLabel, escapeHtml } from '../utils.js';
import { showToast } from '../components/toast.js';
import { showModal } from '../components/modal.js';
import { updateUnconfirmedBadge } from '../components/navbar.js';

let map = null;
let purposeTemplates = [];

async function ensureGoogleMaps() {
    if (window.google?.maps) return true;
    try {
        const result = await api.getPlacesApiKey();
        return new Promise((resolve) => {
            const script = document.createElement('script');
            script.src = `https://maps.googleapis.com/maps/api/js?key=${result.key}&libraries=places,marker`;
            script.async = true;
            script.onload = () => resolve(true);
            script.onerror = () => resolve(false);
            document.head.appendChild(script);
        });
    } catch (e) { return false; }
}

export async function renderTripDetail(tripId) {
    const content = document.getElementById('content');
    document.getElementById('page-title').textContent = 'Detail jazdy';
    document.getElementById('top-actions').innerHTML = `<button class="btn btn-outline btn-sm" onclick="history.back()">&#8592; Späť</button>`;

    content.innerHTML = '<div class="loading"><div class="spinner"></div> Načítavam...</div>';

    try {
        const [trip, templates] = await Promise.all([
            api.getTrip(tripId),
            api.getPurposeTemplates().catch(() => [])
        ]);
        purposeTemplates = templates;

        let suggestion = null;
        if (trip.status === 'UNCONFIRMED') {
            try {
                suggestion = await api.suggestClassification(tripId);
            } catch (e) { /* ignore */ }
        }

        let audit = [];
        try {
            const auditResult = await api.getTripAudit(tripId);
            audit = auditResult.audit_log || [];
        } catch (e) { /* ignore */ }

        let drivers = [];
        try {
            drivers = await api.getDrivers();
        } catch (e) { /* ignore */ }

        renderDetail(trip, suggestion, audit, drivers);
    } catch (err) {
        content.innerHTML = `<div class="alert alert-danger">Chyba: ${err.message}</div>`;
    }
}

function renderDetail(trip, suggestion, audit, drivers) {
    const content = document.getElementById('content');
    const isEditable = trip.status !== 'LOCKED';
    const isPrivate = trip.trip_type === 'private';

    content.innerHTML = `
        ${trip.is_parking ? `
            <div class="alert" style="background:#ecf0f1;border-left:4px solid #95a5a6">
                &#9899; <strong>Zastavenie</strong> - Tento záznam je automaticky detekované zastavenie (malý pohyb, nízka rýchlosť).
                Pomáha rozlíšiť kde sa jazda začala/skončila.
            </div>
        ` : ''}
        ${suggestion?.suggestion?.suggested_type ? `
            <div class="alert alert-info">
                &#128161; Návrh klasifikácie: <strong>${tripTypeLabel(suggestion.suggestion.suggested_type)}</strong>
                ${suggestion.suggestion.suggested_purpose ? ` - ${escapeHtml(suggestion.suggestion.suggested_purpose)}` : ''}
                <button class="btn btn-sm btn-primary" id="btn-apply-suggestion" style="margin-left:12px">Použiť</button>
            </div>
        ` : ''}

        <div class="grid-2">
            <div>
                <div class="card">
                    <div class="card-header"><h3>Mapa</h3></div>
                    <div id="trip-map" class="map-container"></div>
                </div>

                <div class="card">
                    <div class="card-header"><h3>Informácie</h3></div>
                    <table style="width:100%">
                        <tr><td style="font-weight:600;width:40%;padding:8px 0">Začiatok</td><td>${formatDateTime(trip.start_time)}</td></tr>
                        <tr><td style="font-weight:600;padding:8px 0">Koniec</td><td>${formatDateTime(trip.end_time)}</td></tr>
                        <tr><td style="font-weight:600;padding:8px 0">Odkiaľ</td><td>${escapeHtml(trip.start_address) || '-'}</td></tr>
                        <tr><td style="font-weight:600;padding:8px 0">Kam</td><td>${escapeHtml(trip.end_address) || '-'}</td></tr>
                        <tr><td style="font-weight:600;padding:8px 0">Stav tachometra</td><td>${trip.start_odometer != null ? parseFloat(trip.start_odometer).toFixed(1) : '-'} → ${trip.end_odometer != null ? parseFloat(trip.end_odometer).toFixed(1) : '-'} km</td></tr>
                        <tr><td style="font-weight:600;padding:8px 0">Vzdialenosť</td><td>${formatKm(trip.distance_meters)}</td></tr>
                        <tr><td style="font-weight:600;padding:8px 0">Trvanie</td><td>${formatDuration(trip.duration_seconds)}</td></tr>
                        <tr><td style="font-weight:600;padding:8px 0">Vozidlo</td><td>${escapeHtml(trip.vehicle_name || '-')}</td></tr>
                        <tr><td style="font-weight:600;padding:8px 0">Stav</td><td><span class="badge badge-${trip.status === 'CONFIRMED' ? 'confirmed' : trip.status === 'LOCKED' ? 'locked' : 'unconfirmed'}">${trip.status}</span></td></tr>
                    </table>
                </div>
            </div>
            <div>
                <div class="card">
                    <div class="card-header">
                        <h3>Klasifikácia</h3>
                        ${!isEditable ? '<span class="badge badge-locked">Zamknuté</span>' : ''}
                    </div>
                    <form id="trip-form">
                        <div class="form-group">
                            <label>Typ jazdy</label>
                            <select class="form-control" id="edit-trip-type" ${!isEditable ? 'disabled' : ''}>
                                <option value="unconfirmed" ${trip.trip_type === 'unconfirmed' ? 'selected' : ''}>Nepotvrdená</option>
                                <option value="business" ${trip.trip_type === 'business' ? 'selected' : ''}>Služobná</option>
                                <option value="private" ${trip.trip_type === 'private' ? 'selected' : ''}>Privátna</option>
                            </select>
                        </div>
                        <div class="form-group" id="purpose-group" style="${isPrivate ? 'display:none' : ''}">
                            <label>Účel jazdy</label>
                            <select class="form-control" id="edit-purpose-select" ${!isEditable ? 'disabled' : ''}>
                                <option value="">-- Vyberte účel --</option>
                                ${purposeTemplates.map(t => `<option value="${escapeHtml(t.label)}" ${trip.trip_purpose === t.label ? 'selected' : ''}>${escapeHtml(t.label)}</option>`).join('')}
                                <option value="__custom">Vlastný text...</option>
                            </select>
                            <input type="text" class="form-control" id="edit-purpose-text" placeholder="Účel jazdy" value="${escapeHtml(trip.trip_purpose || '')}" style="margin-top:8px" ${!isEditable ? 'disabled' : ''}>
                        </div>
                        <div class="form-group">
                            <label>Vodič</label>
                            <select class="form-control" id="edit-driver" ${!isEditable ? 'disabled' : ''}>
                                <option value="">-- Vyberte vodiča --</option>
                                ${drivers.map(d => `<option value="${d.id}" ${trip.driver_id == d.id ? 'selected' : ''}>${escapeHtml(d.first_name + ' ' + d.last_name)}</option>`).join('')}
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Poznámky</label>
                            <textarea class="form-control" id="edit-notes" ${!isEditable ? 'disabled' : ''}>${escapeHtml(trip.internal_notes || '')}</textarea>
                        </div>
                        ${isEditable ? `
                            <div style="display:flex;gap:8px;flex-wrap:wrap">
                                <button type="submit" class="btn btn-primary">Uložiť</button>
                                ${trip.status === 'UNCONFIRMED' ? `<button type="button" class="btn btn-success" id="btn-save-confirm">Uložiť a potvrdiť</button>` : ''}
                                ${trip.duration_seconds > 600 && !trip.split_from_id ? `<button type="button" class="btn btn-outline" id="btn-split" title="Rozdeliť jazdu na segmenty podľa zastavení">&#9986; Rozdeliť</button>` : ''}
                                <button type="button" class="btn btn-danger" id="btn-delete" style="margin-left:auto">Zmazať</button>
                            </div>
                        ` : ''}
                    </form>
                </div>

                <div class="card">
                    <div class="card-header"><h3>Audit log</h3></div>
                    ${audit.length === 0 ? '<p style="color:var(--text-muted);font-size:13px">Žiadne zmeny</p>' : `
                        <ul class="audit-list">
                            ${audit.map(a => `
                                <li class="audit-item">
                                    <span class="audit-time">${formatDateTime(a.changed_at)}</span>
                                    <span class="audit-action">${escapeHtml(a.action)}</span>
                                    <span>${escapeHtml(a.new_value || '')}</span>
                                </li>
                            `).join('')}
                        </ul>
                    `}
                </div>
            </div>
        </div>
    `;

    // Init map
    initMap(trip);

    // Toggle purpose visibility based on trip type
    const tripTypeSelect = document.getElementById('edit-trip-type');
    const purposeGroup = document.getElementById('purpose-group');

    tripTypeSelect?.addEventListener('change', () => {
        const isNowPrivate = tripTypeSelect.value === 'private';
        purposeGroup.style.display = isNowPrivate ? 'none' : '';
        if (isNowPrivate) {
            document.getElementById('edit-purpose-select').value = '';
            document.getElementById('edit-purpose-text').value = '';
        }
    });

    // Purpose template selector
    document.getElementById('edit-purpose-select')?.addEventListener('change', (e) => {
        const val = e.target.value;
        if (val && val !== '__custom') {
            document.getElementById('edit-purpose-text').value = val;
        }
    });

    // Apply suggestion
    document.getElementById('btn-apply-suggestion')?.addEventListener('click', () => {
        if (suggestion?.suggestion) {
            tripTypeSelect.value = suggestion.suggestion.suggested_type;
            // Trigger visibility update
            tripTypeSelect.dispatchEvent(new Event('change'));
            if (suggestion.suggestion.suggested_purpose) {
                document.getElementById('edit-purpose-text').value = suggestion.suggestion.suggested_purpose;
            }
        }
    });

    // Save form
    document.getElementById('trip-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        await saveTrip(trip.id);
    });

    // Save and confirm
    document.getElementById('btn-save-confirm')?.addEventListener('click', async () => {
        await saveTrip(trip.id, true);
    });

    // Split trip
    document.getElementById('btn-split')?.addEventListener('click', async () => {
        try {
            showToast('Analyzujem GPS dáta...', 'info');
            const result = await api.splitTrip(trip.id);
            showToast(result.message, 'success');
            updateUnconfirmedBadge();
            location.hash = '#/trips';
        } catch (e) {
            showToast('Chyba: ' + e.message, 'error');
        }
    });

    // Delete
    document.getElementById('btn-delete')?.addEventListener('click', () => {
        showModal({
            title: 'Zmazať jazdu',
            body: '<p>Naozaj chcete zmazať túto jazdu? Táto akcia je nevratná.</p>',
            footer: `<button class="btn btn-outline modal-cancel-btn">Zrušiť</button><button class="btn btn-danger" id="confirm-delete">Zmazať</button>`
        });
        document.getElementById('confirm-delete')?.addEventListener('click', async () => {
            try {
                await api.deleteTrip(trip.id);
                showToast('Jazda zmazaná', 'success');
                updateUnconfirmedBadge();
                location.hash = '#/trips';
            } catch (e) {
                showToast('Chyba: ' + e.message, 'error');
            }
        });
        document.querySelector('.modal-cancel-btn')?.addEventListener('click', () => {
            document.querySelector('.modal-overlay')?.remove();
        });
    });
}

async function saveTrip(tripId, confirm = false) {
    const tripType = document.getElementById('edit-trip-type').value;
    const isPrivate = tripType === 'private';

    const data = {
        trip_type: tripType,
        trip_purpose: isPrivate ? null : (document.getElementById('edit-purpose-text').value || null),
        driver_id: document.getElementById('edit-driver').value || null,
        internal_notes: document.getElementById('edit-notes').value
    };

    try {
        await api.updateTrip(tripId, data);

        if (confirm) {
            await api.confirmTrip(tripId, {
                trip_type: data.trip_type,
                trip_purpose: data.trip_purpose,
                driver_id: data.driver_id
            });
            showToast('Jazda potvrdená', 'success');
            updateUnconfirmedBadge();
        } else {
            showToast('Uložené', 'success');
        }

        // Reload detail
        renderTripDetail(tripId);
    } catch (e) {
        showToast('Chyba: ' + e.message, 'error');
    }
}

async function initMap(trip) {
    const container = document.getElementById('trip-map');
    if (!container) return;
    const ready = await ensureGoogleMaps();
    if (!ready) { container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">Google Maps nie je dostupný</div>'; return; }

    const startLat = parseFloat(trip.start_latitude);
    const startLon = parseFloat(trip.start_longitude);
    const endLat = parseFloat(trip.end_latitude);
    const endLon = parseFloat(trip.end_longitude);

    if (isNaN(startLat) || isNaN(startLon)) {
        container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted)">Žiadne GPS súradnice</div>';
        return;
    }

    map = new google.maps.Map(container, {
        center: { lat: startLat, lng: startLon },
        zoom: 13,
        mapTypeControl: true,
        streetViewControl: false,
        fullscreenControl: false
    });

    const startMarker = new google.maps.Marker({
        position: { lat: startLat, lng: startLon },
        map,
        label: { text: 'Z', color: 'white', fontWeight: 'bold', fontSize: '14px' },
        icon: { path: google.maps.SymbolPath.CIRCLE, scale: 14, fillColor: '#27ae60', fillOpacity: 1, strokeColor: 'white', strokeWeight: 2 },
        title: 'Začiatok'
    });
    const startInfo = new google.maps.InfoWindow({ content: `<strong>Začiatok</strong><br>${escapeHtml(trip.start_address || 'N/A')}` });
    startMarker.addListener('click', () => startInfo.open(map, startMarker));

    if (!isNaN(endLat) && !isNaN(endLon)) {
        const endMarker = new google.maps.Marker({
            position: { lat: endLat, lng: endLon },
            map,
            label: { text: 'K', color: 'white', fontWeight: 'bold', fontSize: '14px' },
            icon: { path: google.maps.SymbolPath.CIRCLE, scale: 14, fillColor: '#e74c3c', fillOpacity: 1, strokeColor: 'white', strokeWeight: 2 },
            title: 'Koniec'
        });
        const endInfo = new google.maps.InfoWindow({ content: `<strong>Koniec</strong><br>${escapeHtml(trip.end_address || 'N/A')}` });
        endMarker.addListener('click', () => endInfo.open(map, endMarker));

        new google.maps.Polyline({
            path: [{ lat: startLat, lng: startLon }, { lat: endLat, lng: endLon }],
            strokeColor: '#e74c3c',
            strokeOpacity: 0.6,
            strokeWeight: 3,
            icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '15px' }],
            map
        });

        const bounds = new google.maps.LatLngBounds();
        bounds.extend({ lat: startLat, lng: startLon });
        bounds.extend({ lat: endLat, lng: endLon });
        map.fitBounds(bounds, { top: 40, bottom: 40, left: 40, right: 40 });
    }
}
