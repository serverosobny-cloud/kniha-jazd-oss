// Waypoints view - Google Places search & trip splitting
import { api } from '../api.js';
import { formatDateTime, escapeHtml } from '../utils.js';
import { showToast } from '../components/toast.js';
import { updateUnconfirmedBadge } from '../components/navbar.js';

let state = {
    date: new Date().toISOString().split('T')[0],
    waypoints: [],
    searchResults: [],
    nearestResults: [],
    savedPlaces: [],
    apiKey: null,
    map: null,
    markers: [],
    gmsLoaded: false
};

// Dynamically load Google Maps JS API
function loadGoogleMaps(apiKey) {
    return new Promise((resolve, reject) => {
        if (window.google?.maps) { resolve(); return; }
        const script = document.createElement('script');
        script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=places,marker`;
        script.async = true;
        script.onload = () => { state.gmsLoaded = true; resolve(); };
        script.onerror = () => reject(new Error('Google Maps sa nepodarilo načítať'));
        document.head.appendChild(script);
    });
}

export async function renderWaypoints() {
    const content = document.getElementById('content');
    document.getElementById('page-title').textContent = 'Navštívené miesta';
    document.getElementById('top-actions').innerHTML = '';

    // Load API key, Google Maps, and saved places
    if (!state.apiKey) {
        try {
            const result = await api.getPlacesApiKey();
            state.apiKey = result.key;
        } catch (e) {
            content.innerHTML = `<div class="alert alert-danger">Google API kľúč nie je nakonfigurovaný: ${e.message}</div>`;
            return;
        }
    }
    try { await loadGoogleMaps(state.apiKey); } catch (e) { console.warn('Google Maps load:', e); }
    try {
        const result = await api.getSavedPlaces();
        state.savedPlaces = result.places || [];
    } catch (e) { state.savedPlaces = []; }

    content.innerHTML = `
        <div class="grid-2">
            <div>
                ${state.savedPlaces.length > 0 ? `
                <div class="card">
                    <div class="card-header">
                        <h3>Uložené miesta</h3>
                    </div>
                    <div id="wp-saved-list">
                        ${state.savedPlaces.map((sp, idx) => {
                            return `
                                <div class="wp-result">
                                    <div class="wp-result-info">
                                        <div class="wp-result-name">${escapeHtml(sp.name)}</div>
                                        <div class="wp-result-addr">${escapeHtml(sp.address || '')}</div>
                                    </div>
                                    <button class="btn btn-sm btn-success wp-saved-add-btn"
                                        data-idx="${idx}">
                                        + Pridať
                                    </button>
                                </div>
                            `;
                        }).join('')}
                    </div>
                </div>
                ` : ''}

                <div class="card">
                    <div class="card-header">
                        <h3>Vyhľadať miesto</h3>
                    </div>
                    <div class="form-group">
                        <label>Dátum jazdy</label>
                        <input type="date" class="form-control" id="wp-date" value="${state.date}">
                    </div>
                    <div class="form-group">
                        <label>Hľadať miesto (Google Places)</label>
                        <div style="display:flex;gap:8px">
                            <input type="text" class="form-control" id="wp-search" placeholder="Napr. Tesco Trnava, Stredná škola..." style="flex:1" autocomplete="off">
                            <button class="btn btn-primary" id="wp-search-btn">Hľadať</button>
                        </div>
                    </div>
                    <div id="wp-search-results"></div>
                </div>

                <div class="card" id="wp-list-card" style="${state.waypoints.length === 0 ? 'display:none' : ''}">
                    <div class="card-header">
                        <h3>Vybrané miesta <span class="badge" style="background:var(--primary);color:white" id="wp-count">${state.waypoints.length}</span></h3>
                    </div>
                    <div id="wp-selected-list"></div>
                    <div style="margin-top:16px;display:flex;gap:8px">
                        <button class="btn btn-primary" id="wp-find-nearest" style="flex:1">Nájsť GPS pozície</button>
                        <button class="btn btn-danger btn-outline" id="wp-clear-all">Vymazať všetky</button>
                    </div>
                </div>

                <div class="card" id="wp-results-card" style="display:none">
                    <div class="card-header">
                        <h3>Výsledky priradenia</h3>
                    </div>
                    <div id="wp-nearest-results"></div>
                    <div style="margin-top:16px">
                        <button class="btn btn-success" id="wp-split-trips" style="width:100%">Rozdeliť jazdy podľa navštívených miest</button>
                    </div>
                </div>
            </div>
            <div>
                <div class="card">
                    <div class="card-header"><h3>Mapa</h3></div>
                    <div id="wp-map" class="map-container" style="min-height:500px"></div>
                </div>
            </div>
        </div>
    `;

    initMap();
    renderSelectedWaypoints();
    attachEvents();

    // Saved places add buttons
    document.querySelectorAll('.wp-saved-add-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const sp = state.savedPlaces[parseInt(btn.dataset.idx)];
            addWaypoint({
                id: sp.google_place_id,
                name: sp.name,
                address: sp.address,
                latitude: sp.latitude,
                longitude: sp.longitude,
                type: sp.place_type
            });
        });
    });
}

function initMap() {
    const container = document.getElementById('wp-map');
    if (!container || !window.google?.maps) return;

    state.markers.forEach(m => m.setMap(null));
    state.markers = [];

    state.map = new google.maps.Map(container, {
        center: { lat: 48.37, lng: 17.59 },
        zoom: 10,
        mapTypeControl: true,
        streetViewControl: false,
        fullscreenControl: false
    });

    updateMapMarkers();
}

function updateMapMarkers() {
    if (!state.map) return;

    try {
        state.markers.forEach(m => m.setMap(null));
        state.markers = [];

        const bounds = new google.maps.LatLngBounds();

        state.waypoints.forEach((wp, idx) => {
            if (wp.latitude == null || wp.longitude == null) return;
            const pos = { lat: wp.latitude, lng: wp.longitude };
            const marker = new google.maps.Marker({
                position: pos,
                map: state.map,
                label: { text: String(idx + 1), color: 'white', fontWeight: 'bold', fontSize: '13px' },
                icon: {
                    path: google.maps.SymbolPath.CIRCLE,
                    scale: 14,
                    fillColor: wp.manual ? '#3498db' : '#e74c3c',
                    fillOpacity: 1,
                    strokeColor: 'white',
                    strokeWeight: 2
                },
                title: wp.name
            });

            const infoWindow = new google.maps.InfoWindow({
                content: `<strong>${escapeHtml(wp.name)}</strong><br>${escapeHtml(wp.address || '')}`
            });
            marker.addListener('click', () => infoWindow.open(state.map, marker));

            state.markers.push(marker);
            bounds.extend(pos);
        });

        if (state.waypoints.length > 0) {
            state.map.fitBounds(bounds, { top: 40, bottom: 40, left: 40, right: 40 });
            if (state.waypoints.length === 1) state.map.setZoom(14);
        }
    } catch (e) {
        console.warn('Map markers error:', e);
    }
}

function attachEvents() {
    document.getElementById('wp-date')?.addEventListener('change', (e) => {
        state.date = e.target.value;
    });

    document.getElementById('wp-search-btn')?.addEventListener('click', () => doSearch());

    document.getElementById('wp-search')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            doSearch();
        }
    });

    document.getElementById('wp-find-nearest')?.addEventListener('click', findNearest);

    document.getElementById('wp-clear-all')?.addEventListener('click', () => {
        state.waypoints = [];
        state.nearestResults = [];
        renderSelectedWaypoints();
        updateMapMarkers();
        document.getElementById('wp-list-card').style.display = 'none';
        document.getElementById('wp-results-card').style.display = 'none';
    });

    document.getElementById('wp-split-trips')?.addEventListener('click', splitTrips);
}

async function doSearch() {
    const query = document.getElementById('wp-search').value.trim();
    if (query.length < 2) {
        showToast('Zadajte aspoň 2 znaky', 'warning');
        return;
    }

    const resultsDiv = document.getElementById('wp-search-results');
    resultsDiv.innerHTML = '<div class="loading"><div class="spinner"></div> Vyhľadávam...</div>';

    try {
        // Build request body
        const requestBody = { textQuery: query };

        if (state.map) {
            try {
                const center = state.map.getCenter();
                const lat = typeof center.lat === 'function' ? center.lat() : center.lat;
                const lng = typeof center.lng === 'function' ? center.lng() : center.lng;
                if (lat != null) {
                    requestBody.locationBias = {
                        circle: {
                            center: { latitude: lat, longitude: lng },
                            radius: 50000
                        }
                    };
                }
            } catch (e) { /* ignore */ }
        }

        // Call Google Places API directly from browser
        const response = await fetch('https://places.googleapis.com/v1/places:searchText', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': state.apiKey,
                'X-Goog-FieldMask': 'places.id,places.displayName,places.formattedAddress,places.location,places.types,places.primaryType,places.shortFormattedAddress'
            },
            body: JSON.stringify(requestBody)
        });

        if (!response.ok) {
            const err = await response.json().catch(() => ({}));
            throw new Error(err.error?.message || `HTTP ${response.status}`);
        }

        const data = await response.json();
        state.searchResults = (data.places || []).map(p => ({
            id: p.id,
            name: p.displayName?.text || p.displayName,
            address: p.formattedAddress || p.shortFormattedAddress || '',
            latitude: p.location?.latitude,
            longitude: p.location?.longitude,
            type: p.primaryType || (p.types && p.types[0]) || null
        }));

        if (state.searchResults.length === 0) {
            resultsDiv.innerHTML = '<p style="color:var(--text-muted);font-size:13px;padding:8px 0">Nenašli sa žiadne výsledky</p>';
            return;
        }

        resultsDiv.innerHTML = state.searchResults.map((place, idx) => {
            const typeLabel = placeTypeLabel(place.type);
            return `
                <div class="wp-result" data-idx="${idx}">
                    <div class="wp-result-info">
                        <div class="wp-result-name">${escapeHtml(place.name)}</div>
                        <div class="wp-result-addr">${escapeHtml(place.address)}</div>
                        ${typeLabel ? `<span class="wp-result-type">${typeLabel}</span>` : ''}
                    </div>
                    <button class="btn btn-sm btn-success wp-add-btn" data-idx="${idx}">
                        Tu som bol
                    </button>
                </div>
            `;
        }).join('');

        resultsDiv.querySelectorAll('.wp-add-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const idx = parseInt(e.target.dataset.idx);
                addWaypoint(state.searchResults[idx]);
            });
        });
    } catch (err) {
        resultsDiv.innerHTML = `<div class="alert alert-danger" style="font-size:13px">Chyba: ${escapeHtml(err.message)}</div>`;
    }
}

function addWaypoint(place) {
    state.waypoints.push({
        id: place.id,
        name: place.name,
        address: place.address,
        latitude: place.latitude,
        longitude: place.longitude,
        type: place.type,
        manual: false
    });

    renderSelectedWaypoints();
    updateMapMarkers();
    document.getElementById('wp-list-card').style.display = '';

    // Clear search field and results
    const searchInput = document.getElementById('wp-search');
    if (searchInput) searchInput.value = '';
    const resultsDiv = document.getElementById('wp-search-results');
    if (resultsDiv) resultsDiv.innerHTML = '';

    showToast(`${escapeHtml(place.name)} pridané`, 'success');
}

function removeWaypoint(idx) {
    state.waypoints.splice(idx, 1);
    renderSelectedWaypoints();
    updateMapMarkers();

    if (state.waypoints.length === 0) {
        document.getElementById('wp-list-card').style.display = 'none';
        document.getElementById('wp-results-card').style.display = 'none';
    }
}

function renderSelectedWaypoints() {
    const listDiv = document.getElementById('wp-selected-list');
    const countBadge = document.getElementById('wp-count');
    if (!listDiv) return;

    if (countBadge) countBadge.textContent = state.waypoints.length;

    if (state.waypoints.length === 0) {
        listDiv.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Zatiaľ neboli vybrané žiadne miesta</p>';
        return;
    }

    listDiv.innerHTML = state.waypoints.map((wp, idx) => `
        <div class="wp-selected-item ${wp.manual ? 'wp-manual' : ''}">
            <div class="wp-order-btns">
                <button class="wp-order-btn wp-move-up" data-idx="${idx}" title="Posunúť hore" ${idx === 0 ? 'disabled' : ''}>&#9650;</button>
                <span class="wp-selected-num">${idx + 1}</span>
                <button class="wp-order-btn wp-move-down" data-idx="${idx}" title="Posunúť dole" ${idx === state.waypoints.length - 1 ? 'disabled' : ''}>&#9660;</button>
            </div>
            <div class="wp-selected-info">
                <div class="wp-selected-name">${escapeHtml(wp.name)}</div>
                <div class="wp-selected-addr">${escapeHtml(wp.address || '')}</div>
            </div>
            <button class="btn btn-sm ${wp.manual ? 'btn-warning' : 'btn-outline'} wp-manual-btn" data-idx="${idx}" title="${wp.manual ? 'Prepnúť na GPS' : 'Označiť ako manuálny (bez GPS)'}">
                ${wp.manual ? 'M' : 'GPS'}
            </button>
            <button class="btn btn-sm btn-outline btn-danger wp-remove-btn" data-idx="${idx}" title="Odstrániť">&#10005;</button>
        </div>
    `).join('');

    listDiv.querySelectorAll('.wp-move-up').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            if (idx > 0) {
                [state.waypoints[idx - 1], state.waypoints[idx]] = [state.waypoints[idx], state.waypoints[idx - 1]];
                renderSelectedWaypoints();
                updateMapMarkers();
            }
        });
    });

    listDiv.querySelectorAll('.wp-move-down').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            if (idx < state.waypoints.length - 1) {
                [state.waypoints[idx], state.waypoints[idx + 1]] = [state.waypoints[idx + 1], state.waypoints[idx]];
                renderSelectedWaypoints();
                updateMapMarkers();
            }
        });
    });

    listDiv.querySelectorAll('.wp-manual-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.idx);
            state.waypoints[idx].manual = !state.waypoints[idx].manual;
            renderSelectedWaypoints();
        });
    });

    listDiv.querySelectorAll('.wp-remove-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            removeWaypoint(parseInt(e.target.closest('[data-idx]').dataset.idx));
        });
    });
}

async function findNearest() {
    if (state.waypoints.length === 0) {
        showToast('Najprv pridajte miesta', 'warning');
        return;
    }

    if (!state.date) {
        showToast('Vyberte dátum', 'warning');
        return;
    }

    const resultsCard = document.getElementById('wp-results-card');
    const resultsDiv = document.getElementById('wp-nearest-results');
    resultsCard.style.display = '';
    resultsDiv.innerHTML = '<div class="loading"><div class="spinner"></div> Hľadám najbližšie GPS pozície...</div>';

    try {
        const result = await api.findNearestPositions(state.date, state.waypoints);
        state.nearestResults = result.results || [];

        if (state.nearestResults.length === 0) {
            resultsDiv.innerHTML = `
                <div class="alert" style="background:var(--warning-light);border-left:4px solid var(--warning)">
                    Nenašli sa žiadne GPS pozície v blízkosti vybraných miest pre dátum ${escapeHtml(state.date)}.
                    Skúste iný dátum alebo skontrolujte, či boli importované GPS pozície.
                </div>
            `;
            document.getElementById('wp-split-trips').style.display = 'none';
            return;
        }

        const hasGpsCount = state.nearestResults.filter(r => r.has_gps).length;
        const noGpsCount = state.nearestResults.length - hasGpsCount;

        resultsDiv.innerHTML = `
            ${noGpsCount > 0 ? `
                <div class="alert" style="background:#fff3cd;border-left:4px solid #ffc107;margin-bottom:12px;padding:10px 14px;font-size:13px">
                    <strong>${noGpsCount} z ${state.nearestResults.length} miest</strong> nemá GPS dáta v blízkosti.
                    Pre tieto úseky sa vytvorí manuálny záznam s odhadnutou vzdialenosťou.
                </div>
            ` : ''}
            <table style="width:100%;font-size:13px">
                <thead>
                    <tr>
                        <th style="padding:8px 4px">#</th>
                        <th style="padding:8px 4px">Miesto</th>
                        <th style="padding:8px 4px">GPS čas</th>
                        <th style="padding:8px 4px">Vzdialenosť</th>
                        <th style="padding:8px 4px">Stav</th>
                    </tr>
                </thead>
                <tbody>
                    ${state.nearestResults.map(r => {
                        const toggleBtn = `<button class="btn btn-sm wp-result-toggle" data-order="${r.order}" style="font-size:11px;padding:2px 8px;min-width:32px"
                            title="${r.manual ? 'Prepnúť na GPS hľadanie' : 'Označiť ako manuálny'}">${r.manual ? 'M' : (r.has_gps ? 'GPS' : '?')}</button>`;
                        if (r.has_gps) {
                            const distColor = r.distance_m < 200 ? 'var(--success)' : r.distance_m < 1000 ? 'var(--warning)' : 'var(--danger)';
                            return `
                                <tr>
                                    <td style="padding:6px 4px;font-weight:600">${r.order + 1}</td>
                                    <td style="padding:6px 4px"><strong>${escapeHtml(r.waypoint.name)}</strong></td>
                                    <td style="padding:6px 4px">${formatDateTime(r.nearest_time)}</td>
                                    <td style="padding:6px 4px">
                                        <span style="color:${distColor};font-weight:600">${r.distance_m} m</span>
                                    </td>
                                    <td style="padding:6px 4px">${toggleBtn}</td>
                                </tr>
                            `;
                        } else if (r.manual) {
                            return `
                                <tr style="background:#e8f4fd">
                                    <td style="padding:6px 4px;font-weight:600">${r.order + 1}</td>
                                    <td style="padding:6px 4px"><strong>${escapeHtml(r.waypoint.name)}</strong></td>
                                    <td style="padding:6px 4px;color:var(--text-muted)">-</td>
                                    <td style="padding:6px 4px;color:var(--text-muted)">-</td>
                                    <td style="padding:6px 4px">${toggleBtn}</td>
                                </tr>
                            `;
                        } else {
                            return `
                                <tr style="background:#fff8e1">
                                    <td style="padding:6px 4px;font-weight:600">${r.order + 1}</td>
                                    <td style="padding:6px 4px"><strong>${escapeHtml(r.waypoint.name)}</strong></td>
                                    <td style="padding:6px 4px;color:var(--text-muted)">-</td>
                                    <td style="padding:6px 4px;color:var(--text-muted)">-</td>
                                    <td style="padding:6px 4px">${toggleBtn}</td>
                                </tr>
                            `;
                        }
                    }).join('')}
                </tbody>
            </table>
        `;

        // Toggle manual/GPS buttons in results table
        resultsDiv.querySelectorAll('.wp-result-toggle').forEach(btn => {
            btn.addEventListener('click', () => {
                const order = parseInt(btn.dataset.order);
                if (state.waypoints[order]) {
                    state.waypoints[order].manual = !state.waypoints[order].manual;
                    renderSelectedWaypoints();
                    findNearest(); // Re-run search
                }
            });
        });

        document.getElementById('wp-split-trips').style.display = '';

        // Add nearest GPS position markers on map (blue dots) + route line
        try {
            if (state.map && window.google?.maps) {
                state.nearestResults.forEach(r => {
                    if (!r.has_gps || r.nearest_lat == null || r.nearest_lon == null) return;
                    const pos = { lat: r.nearest_lat, lng: r.nearest_lon };
                    const marker = new google.maps.Marker({
                        position: pos,
                        map: state.map,
                        icon: {
                            path: google.maps.SymbolPath.CIRCLE,
                            scale: 6,
                            fillColor: '#3498db',
                            fillOpacity: 1,
                            strokeColor: 'white',
                            strokeWeight: 2
                        },
                        title: `GPS ${formatDateTime(r.nearest_time)}`
                    });
                    const info = new google.maps.InfoWindow({
                        content: `GPS pozícia<br>${formatDateTime(r.nearest_time)}<br>Vzdialenosť: ${r.distance_m}m`
                    });
                    marker.addListener('click', () => info.open(state.map, marker));
                    state.markers.push(marker);
                });

                // Draw dashed line between waypoints in order
                const wpCoords = state.waypoints
                    .filter(w => w.latitude != null && w.longitude != null)
                    .map(w => ({ lat: w.latitude, lng: w.longitude }));
                if (wpCoords.length >= 2) {
                    const line = new google.maps.Polyline({
                        path: wpCoords,
                        strokeColor: '#e74c3c',
                        strokeOpacity: 0.6,
                        strokeWeight: 2,
                        icons: [{ icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, scale: 3 }, offset: '0', repeat: '15px' }],
                        map: state.map
                    });
                    state.markers.push(line);
                }
            }
        } catch (mapErr) {
            console.warn('Map markers error:', mapErr);
        }
    } catch (err) {
        resultsDiv.innerHTML = `<div class="alert alert-danger">Chyba: ${escapeHtml(err.message)}</div>`;
    }
}

async function splitTrips() {
    if (state.waypoints.length < 2 || !state.date) {
        showToast('Treba aspoň 2 miesta pre rozdelenie jázd', 'warning');
        return;
    }

    const btn = document.getElementById('wp-split-trips');
    btn.disabled = true;
    btn.textContent = 'Rozdeľujem...';

    try {
        const result = await api.splitByWaypoints(state.date, state.waypoints);
        showToast(result.message, 'success');
        updateUnconfirmedBadge();

        const resultsDiv = document.getElementById('wp-nearest-results');
        resultsDiv.innerHTML = `
            <div class="alert" style="background:var(--success-light);border-left:4px solid var(--success)">
                <strong>Hotovo!</strong> ${escapeHtml(result.message)}
            </div>
            ${result.details?.length ? `
                <table style="width:100%;font-size:13px;margin-top:8px">
                    <thead>
                        <tr>
                            <th style="padding:8px 4px">Odkiaľ</th>
                            <th style="padding:8px 4px">Kam</th>
                            <th style="padding:8px 4px">Vzdialenosť</th>
                            <th style="padding:8px 4px">Typ</th>
                            <th style="padding:8px 4px">Jazda</th>
                        </tr>
                    </thead>
                    <tbody>
                        ${result.details.map(d => `
                            <tr ${d.manual ? 'style="background:#fff8e1"' : ''}>
                                <td style="padding:6px 4px">${escapeHtml(d.from)}</td>
                                <td style="padding:6px 4px">${escapeHtml(d.to)}</td>
                                <td style="padding:6px 4px" id="route-dist-${d.id}">${(d.distance_m / 1000).toFixed(1)} km</td>
                                <td style="padding:6px 4px">
                                    ${d.manual
                                        ? '<span style="color:#e67e22;font-weight:600">Manuálne</span>'
                                        : '<span style="color:var(--success);font-weight:600">GPS</span>'}
                                </td>
                                <td style="padding:6px 4px"><a href="#/trips/${d.id}">Jazda #${d.id}</a></td>
                            </tr>
                        `).join('')}
                    </tbody>
                </table>
            ` : ''}
            ${result.manual_segments?.length > 0 ? `
                <div class="alert" style="background:#fff3cd;border-left:4px solid #ffc107;margin-top:10px;padding:10px 14px;font-size:13px">
                    <strong>${result.manual_segments.length} úsek(ov)</strong> bez GPS - vzdialenosť je odhad (vzdušná * 1.3).
                    Môžete upraviť v detaile jazdy.
                </div>
            ` : ''}
            <div style="margin-top:12px">
                <a href="#/trips?date_from=${state.date}&date_to=${state.date}" class="btn btn-outline">Zobraziť jazdy za ${state.date}</a>
            </div>
        `;

        btn.style.display = 'none';

        // Calculate real driving distances via Routes API
        if (result.details?.length) {
            showToast('Prepočítavam vzdialenosti cez Google Routes...', 'info');
            await calculateRouteDistances(result.details);
            showToast('Vzdialenosti aktualizované', 'success');
        }
    } catch (err) {
        showToast('Chyba: ' + err.message, 'error');
        btn.disabled = false;
        btn.textContent = 'Rozdeliť jazdy podľa navštívených miest';
    }
}

/**
 * Calculate real driving distance using Google Routes API
 * Uses waypoints for accurate route calculation
 */
async function calculateRouteDistances(details) {
    if (!state.apiKey || !details?.length) return;

    for (const segment of details) {
        if (!segment.from_lat || !segment.to_lat) continue;

        try {
            // Build waypoints from the segment's intermediate points if any
            const body = {
                origin: { location: { latLng: { latitude: segment.from_lat, longitude: segment.from_lon } } },
                destination: { location: { latLng: { latitude: segment.to_lat, longitude: segment.to_lon } } },
                travelMode: 'DRIVE',
                routingPreference: 'TRAFFIC_UNAWARE'
            };

            const response = await fetch('https://routes.googleapis.com/directions/v2:computeRoutes', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'X-Goog-Api-Key': state.apiKey,
                    'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration'
                },
                body: JSON.stringify(body)
            });

            if (!response.ok) continue;

            const data = await response.json();
            const route = data.routes?.[0];
            if (route?.distanceMeters) {
                // Update trip with real distance
                await api.updateTrip(segment.id, { distance_meters: route.distanceMeters });
                // Update display
                const distCell = document.querySelector(`#route-dist-${segment.id}`);
                if (distCell) distCell.textContent = (route.distanceMeters / 1000).toFixed(1) + ' km';
            }
        } catch (e) {
            console.warn(`Route calc failed for trip ${segment.id}:`, e);
        }
    }
}

function placeTypeLabel(type) {
    const labels = {
        restaurant: 'Reštaurácia',
        cafe: 'Kaviareň',
        store: 'Obchod',
        shopping_mall: 'Nákupné centrum',
        gas_station: 'Čerpacia stanica',
        car_repair: 'Autoservis',
        car_dealer: 'Predajca áut',
        school: 'Škola',
        university: 'Univerzita',
        hospital: 'Nemocnica',
        doctor: 'Lekár',
        pharmacy: 'Lekáreň',
        bank: 'Banka',
        post_office: 'Pošta',
        city_hall: 'Mestský úrad',
        courthouse: 'Súd',
        police: 'Polícia',
        church: 'Kostol',
        gym: 'Fitnes',
        parking: 'Parkovisko',
        hotel: 'Hotel',
        supermarket: 'Supermarket',
        hardware_store: 'Železiarstvo',
        electronics_store: 'Elektro',
        furniture_store: 'Nábytok',
        home_improvement_store: 'Stavebniny',
    };
    return labels[type] || null;
}
