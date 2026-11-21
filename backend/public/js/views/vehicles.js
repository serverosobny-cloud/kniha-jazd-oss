// Vehicles view
import { api } from '../api.js';
import { formatKm, formatNumber, escapeHtml } from '../utils.js';
import { showToast } from '../components/toast.js';
import { showModal, closeModal } from '../components/modal.js';

export async function renderVehicles() {
    const content = document.getElementById('content');
    document.getElementById('page-title').textContent = 'Vozidlá';
    document.getElementById('top-actions').innerHTML = `
        <button class="btn btn-primary btn-sm" id="btn-add-vehicle"><span>+</span> <span>Pridať</span></button>
    `;

    content.innerHTML = '<div class="loading"><div class="spinner"></div> Načítavam...</div>';

    try {
        const vehicles = await api.getVehicles();
        renderVehicleList(vehicles);
    } catch (err) {
        content.innerHTML = `<div class="alert alert-danger">Chyba: ${err.message}</div>`;
    }

    document.getElementById('btn-add-vehicle')?.addEventListener('click', () => showVehicleForm());
}

function renderVehicleList(vehicles) {
    const content = document.getElementById('content');

    if (vehicles.length === 0) {
        content.innerHTML = `
            <div class="empty-state">
                <div class="icon">&#128663;</div>
                <h3>Žiadne vozidlá</h3>
                <p>Pridajte prvé vozidlo alebo synchronizujte z Traccar.</p>
                <button class="btn btn-primary" id="btn-sync-devices">Synchronizovať z Traccar</button>
            </div>
        `;
        document.getElementById('btn-sync-devices')?.addEventListener('click', syncDevices);
        return;
    }

    content.innerHTML = `
        <div class="zone-list">
            ${vehicles.map(v => `
                <div class="zone-card" data-id="${v.id}">
                    <h4>
                        ${escapeHtml(v.name || 'Vozidlo')}
                        <span style="font-size:13px;font-weight:400;color:var(--text-muted)">${escapeHtml(v.registration_plate || '')}</span>
                    </h4>
                    <div style="font-size:13px;color:var(--text-muted)">
                        ${v.brand ? escapeHtml(v.brand) + ' ' : ''}${v.model ? escapeHtml(v.model) : ''} ${v.year || ''}
                    </div>
                    <div style="display:flex;gap:16px;font-size:13px">
                        <span><strong>${formatNumber(v.trips_count)}</strong> jázd</span>
                        <span><strong>${formatKm(v.total_distance)}</strong></span>
                    </div>
                    <div style="display:flex;gap:8px;margin-top:8px">
                        <button class="btn btn-outline btn-sm btn-edit" data-id="${v.id}">Upraviť</button>
                        <button class="btn btn-outline btn-sm btn-devices" data-id="${v.id}">Zariadenia</button>
                        <button class="btn btn-danger btn-sm btn-delete" data-id="${v.id}" style="margin-left:auto">Zmazať</button>
                    </div>
                </div>
            `).join('')}
        </div>
    `;

    // Edit buttons
    document.querySelectorAll('.btn-edit').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            try {
                const vehicle = await api.getVehicle(id);
                showVehicleForm(vehicle);
            } catch (e) {
                showToast('Chyba: ' + e.message, 'error');
            }
        });
    });

    // Devices buttons
    document.querySelectorAll('.btn-devices').forEach(btn => {
        btn.addEventListener('click', () => showDevicesModal(parseInt(btn.dataset.id)));
    });

    // Delete buttons
    document.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = btn.dataset.id;
            if (!confirm('Naozaj chcete zmazať toto vozidlo?')) return;
            try {
                await api.deleteVehicle(id);
                showToast('Vozidlo zmazané', 'success');
                renderVehicles();
            } catch (e) {
                showToast('Chyba: ' + e.message, 'error');
            }
        });
    });
}

function showVehicleForm(vehicle = null) {
    const isEdit = !!vehicle;
    const body = document.createElement('div');
    body.innerHTML = `
        <form id="vehicle-form">
            <div class="form-group">
                <label>Názov</label>
                <input type="text" class="form-control" id="v-name" value="${escapeHtml(vehicle?.name || '')}" required>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>EČV</label>
                    <input type="text" class="form-control" id="v-plate" value="${escapeHtml(vehicle?.registration_plate || '')}">
                </div>
                <div class="form-group">
                    <label>VIN</label>
                    <input type="text" class="form-control" id="v-vin" value="${escapeHtml(vehicle?.vin || '')}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Značka</label>
                    <input type="text" class="form-control" id="v-brand" value="${escapeHtml(vehicle?.brand || '')}">
                </div>
                <div class="form-group">
                    <label>Model</label>
                    <input type="text" class="form-control" id="v-model" value="${escapeHtml(vehicle?.model || '')}">
                </div>
            </div>
            <div class="form-row">
                <div class="form-group">
                    <label>Rok výroby</label>
                    <input type="number" class="form-control" id="v-year" value="${vehicle?.year || ''}">
                </div>
                <div class="form-group">
                    <label>Palivo</label>
                    <select class="form-control" id="v-fuel">
                        <option value="">-</option>
                        <option value="diesel" ${vehicle?.fuel_type === 'diesel' ? 'selected' : ''}>Diesel</option>
                        <option value="petrol" ${vehicle?.fuel_type === 'petrol' ? 'selected' : ''}>Benzín</option>
                        <option value="electric" ${vehicle?.fuel_type === 'electric' ? 'selected' : ''}>Elektro</option>
                        <option value="hybrid" ${vehicle?.fuel_type === 'hybrid' ? 'selected' : ''}>Hybrid</option>
                        <option value="lpg" ${vehicle?.fuel_type === 'lpg' ? 'selected' : ''}>LPG</option>
                    </select>
                </div>
            </div>
            <div class="form-group">
                <label>Počiatočný stav tachometra (km)</label>
                <input type="number" class="form-control" id="v-odometer" step="0.1" value="${vehicle?.initial_odometer || 0}" placeholder="Stav km pred prvou jazdou v systéme">
                <small style="color:var(--text-muted)">Stav tachometra pred začiatkom evidencie jázd</small>
            </div>
        </form>
    `;

    const modal = showModal({
        title: isEdit ? 'Upraviť vozidlo' : 'Nové vozidlo',
        body,
        footer: `<button class="btn btn-outline" id="modal-cancel">Zrušiť</button><button class="btn btn-primary" id="modal-save">Uložiť</button>`
    });

    document.getElementById('modal-cancel')?.addEventListener('click', () => modal.close());
    document.getElementById('modal-save')?.addEventListener('click', async () => {
        const data = {
            name: document.getElementById('v-name').value,
            registration_plate: document.getElementById('v-plate').value,
            vin: document.getElementById('v-vin').value,
            brand: document.getElementById('v-brand').value,
            model: document.getElementById('v-model').value,
            year: document.getElementById('v-year').value ? parseInt(document.getElementById('v-year').value) : null,
            fuel_type: document.getElementById('v-fuel').value,
            initial_odometer: parseFloat(document.getElementById('v-odometer').value) || 0
        };

        if (!data.name) { showToast('Názov je povinný', 'warning'); return; }

        try {
            if (isEdit) {
                await api.updateVehicle(vehicle.id, data);
                showToast('Vozidlo aktualizované', 'success');
            } else {
                await api.createVehicle(data);
                showToast('Vozidlo vytvorené', 'success');
            }
            modal.close();
            renderVehicles();
        } catch (e) {
            showToast('Chyba: ' + e.message, 'error');
        }
    });
}

async function showDevicesModal(vehicleId) {
    const body = document.createElement('div');
    body.innerHTML = '<div class="loading"><div class="spinner"></div> Načítavam...</div>';

    const modal = showModal({
        title: 'Traccar zariadenia',
        body,
        footer: `<button class="btn btn-outline" id="modal-close-devices">Zavrieť</button>`
    });

    document.getElementById('modal-close-devices')?.addEventListener('click', () => modal.close());

    try {
        const [devices, traccarDevices] = await Promise.all([
            api.getVehicleDevices(vehicleId),
            api.syncDevices().then(r => r.devices || []).catch(() => [])
        ]);

        body.innerHTML = `
            <div style="margin-bottom:16px">
                <h4 style="margin-bottom:8px">Priradené zariadenia</h4>
                ${devices.length === 0 ? '<p style="color:var(--text-muted);font-size:13px">Žiadne zariadenia</p>' : `
                    <table style="width:100%">
                        <thead><tr><th>ID</th><th>Názov</th><th></th></tr></thead>
                        <tbody>
                            ${devices.map(d => `
                                <tr>
                                    <td>${d.traccar_device_id}</td>
                                    <td>${escapeHtml(d.device_name || '-')}</td>
                                    <td><button class="btn btn-danger btn-sm btn-remove-device" data-id="${d.id}">Odstrániť</button></td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                `}
            </div>
            <div>
                <h4 style="margin-bottom:8px">Pridať zariadenie</h4>
                <div style="display:flex;gap:8px">
                    <select class="form-control" id="add-device-select" style="flex:1">
                        <option value="">-- Vyberte zariadenie --</option>
                        ${traccarDevices.map(d => `<option value="${d.id}">${escapeHtml(d.name)} (ID: ${d.id})</option>`).join('')}
                    </select>
                    <button class="btn btn-primary" id="btn-add-device">Pridať</button>
                </div>
            </div>
        `;

        // Remove device handlers
        body.querySelectorAll('.btn-remove-device').forEach(btn => {
            btn.addEventListener('click', async () => {
                try {
                    await api.removeVehicleDevice(vehicleId, btn.dataset.id);
                    showToast('Zariadenie odstránené', 'success');
                    showDevicesModal(vehicleId);
                } catch (e) {
                    showToast('Chyba: ' + e.message, 'error');
                }
            });
        });

        // Add device handler
        body.querySelector('#btn-add-device')?.addEventListener('click', async () => {
            const select = body.querySelector('#add-device-select');
            const deviceId = parseInt(select.value);
            if (!deviceId) { showToast('Vyberte zariadenie', 'warning'); return; }

            try {
                const deviceName = select.options[select.selectedIndex].text;
                await api.addVehicleDevice(vehicleId, {
                    traccar_device_id: deviceId,
                    device_name: deviceName
                });
                showToast('Zariadenie priradené', 'success');
                showDevicesModal(vehicleId);
            } catch (e) {
                showToast('Chyba: ' + e.message, 'error');
            }
        });
    } catch (e) {
        body.innerHTML = `<div class="alert alert-danger">Chyba: ${e.message}</div>`;
    }
}

async function syncDevices() {
    try {
        showToast('Synchronizujem zariadenia...', 'info');
        await api.syncDevices();
        showToast('Zariadenia synchronizované', 'success');
        renderVehicles();
    } catch (e) {
        showToast('Chyba: ' + e.message, 'error');
    }
}
