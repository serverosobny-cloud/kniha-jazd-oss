// Export view
import { api } from '../api.js';
import { showToast } from '../components/toast.js';
import { showModal } from '../components/modal.js';
import { formatDateTime, escapeHtml } from '../utils.js';

export async function renderExport() {
    const content = document.getElementById('content');
    document.getElementById('page-title').textContent = 'Export';
    document.getElementById('top-actions').innerHTML = '';

    content.innerHTML = '<div class="loading"><div class="spinner"></div> Načítavam...</div>';

    try {
        const [vehicles, drivers, history] = await Promise.all([
            api.getVehicles(),
            api.getDrivers(),
            api.getExportHistory().catch(() => [])
        ]);

        const now = new Date();
        const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
        const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

        content.innerHTML = `
            <div class="card">
                <div class="card-header"><h3>Exportovať knihu jázd</h3></div>
                <form id="export-form">
                    <div class="form-row">
                        <div class="form-group">
                            <label>Vozidlo</label>
                            <select class="form-control" id="export-vehicle">
                                <option value="">Všetky</option>
                                ${vehicles.map(v => `<option value="${v.id}">${escapeHtml(v.name || v.registration_plate)}</option>`).join('')}
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Vodič</label>
                            <select class="form-control" id="export-driver">
                                <option value="">Všetci</option>
                                ${drivers.map(d => `<option value="${d.id}">${escapeHtml(d.first_name + ' ' + d.last_name)}</option>`).join('')}
                            </select>
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label>Od</label>
                            <input type="date" class="form-control" id="export-from" value="${monthStart}">
                        </div>
                        <div class="form-group">
                            <label>Do</label>
                            <input type="date" class="form-control" id="export-to" value="${monthEnd}">
                        </div>
                    </div>
                    <div class="form-row">
                        <div class="form-group">
                            <label>Typ jazdy</label>
                            <select class="form-control" id="export-type">
                                <option value="">Všetky</option>
                                <option value="business">Služobná</option>
                                <option value="private">Privátna</option>
                            </select>
                        </div>
                        <div class="form-group">
                            <label>Formát</label>
                            <select class="form-control" id="export-format">
                                <option value="csv">CSV (Excel)</option>
                                <option value="pdf">PDF</option>
                            </select>
                        </div>
                    </div>
                    <div style="display:flex;gap:8px;margin-top:8px">
                        <button type="submit" class="btn btn-primary btn-lg">&#8681; Exportovať</button>
                    </div>
                </form>
            </div>

            <div class="card">
                <div class="card-header"><h3>História exportov</h3></div>
                ${!history || history.length === 0 ? '<p style="color:var(--text-muted)">Žiadne exporty</p>' : `
                    <table>
                        <thead><tr><th>Dátum</th><th>Formát</th><th>Vozidlo</th><th>Obdobie</th><th>Jázd</th></tr></thead>
                        <tbody>
                            ${history.map(h => `
                                <tr>
                                    <td>${formatDateTime(h.generated_at)}</td>
                                    <td><span class="badge badge-${h.export_type === 'PDF' ? 'private' : 'business'}">${h.export_type}</span></td>
                                    <td>${escapeHtml(h.vehicle_name || 'Všetky')}</td>
                                    <td>${h.period_start || '-'} - ${h.period_end || '-'}</td>
                                    <td>${h.trips_count || 0}</td>
                                </tr>
                            `).join('')}
                        </tbody>
                    </table>
                `}
            </div>
        `;

        document.getElementById('export-form')?.addEventListener('submit', async (e) => {
            e.preventDefault();
            await doExport();
        });

    } catch (err) {
        content.innerHTML = `<div class="alert alert-danger">Chyba: ${err.message}</div>`;
    }
}

async function doExport() {
    const format = document.getElementById('export-format').value;
    const data = {
        vehicle_id: document.getElementById('export-vehicle').value || undefined,
        driver_id: document.getElementById('export-driver').value || undefined,
        period_start: document.getElementById('export-from').value || undefined,
        period_end: document.getElementById('export-to').value || undefined,
        trip_type: document.getElementById('export-type').value || undefined
    };

    try {
        showToast('Generujem export...', 'info');

        const response = format === 'pdf'
            ? await api.exportPdf(data)
            : await api.exportCsv(data);

        // Download the file
        const blob = await response.blob();
        const url = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `kniha_jazd_${Date.now()}.${format}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        window.URL.revokeObjectURL(url);

        showToast('Export dokončený', 'success');
        // Reload to show in history
        setTimeout(() => renderExport(), 1000);

    } catch (e) {
        showToast('Chyba: ' + e.message, 'error');
    }
}
