// Filters bar component

export function renderFilters(options = {}) {
    const { vehicles = [], onFilter, currentFilters = {} } = options;

    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
    const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];

    return `
        <div class="filters-bar" id="filters-bar">
            <div class="filter-group">
                <label>Vozidlo</label>
                <select class="form-control" id="filter-vehicle">
                    <option value="">Všetky</option>
                    ${vehicles.map(v => `<option value="${v.id}" ${currentFilters.vehicle_id == v.id ? 'selected' : ''}>${v.name || v.registration_plate}</option>`).join('')}
                </select>
            </div>
            <div class="filter-group">
                <label>Od</label>
                <input type="date" class="form-control" id="filter-from" value="${currentFilters.from || monthStart}">
            </div>
            <div class="filter-group">
                <label>Do</label>
                <input type="date" class="form-control" id="filter-to" value="${currentFilters.to || monthEnd}">
            </div>
            <div class="filter-group">
                <label>Typ</label>
                <select class="form-control" id="filter-type">
                    <option value="">Všetky</option>
                    <option value="business" ${currentFilters.trip_type === 'business' ? 'selected' : ''}>Služobná</option>
                    <option value="private" ${currentFilters.trip_type === 'private' ? 'selected' : ''}>Privátna</option>
                    <option value="unconfirmed" ${currentFilters.trip_type === 'unconfirmed' ? 'selected' : ''}>Nepotvrdená</option>
                </select>
            </div>
            <div class="filter-group">
                <label>Stav</label>
                <select class="form-control" id="filter-status">
                    <option value="">Všetky</option>
                    <option value="UNCONFIRMED" ${currentFilters.status === 'UNCONFIRMED' ? 'selected' : ''}>Nepotvrdené</option>
                    <option value="CONFIRMED" ${currentFilters.status === 'CONFIRMED' ? 'selected' : ''}>Potvrdené</option>
                    <option value="LOCKED" ${currentFilters.status === 'LOCKED' ? 'selected' : ''}>Zamknuté</option>
                </select>
            </div>
            <div class="filter-group" style="align-self:flex-end">
                <label style="display:flex;align-items:center;gap:6px;cursor:pointer;font-size:13px">
                    <input type="checkbox" id="filter-hide-parking" ${currentFilters.hide_parking ? 'checked' : ''}>
                    Skryť zastavenia
                </label>
            </div>
            <button class="btn btn-primary" id="filter-apply">Filtrovať</button>
            <button class="btn btn-outline" id="filter-reset">Reset</button>
        </div>
    `;
}

export function attachFilterEvents(onFilter) {
    const applyBtn = document.getElementById('filter-apply');
    const resetBtn = document.getElementById('filter-reset');

    if (applyBtn) {
        applyBtn.addEventListener('click', () => {
            onFilter(getFilterValues());
        });
    }

    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            document.getElementById('filter-vehicle').value = '';
            document.getElementById('filter-type').value = '';
            document.getElementById('filter-status').value = '';
            const now = new Date();
            document.getElementById('filter-from').value = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];
            document.getElementById('filter-to').value = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split('T')[0];
            onFilter(getFilterValues());
        });
    }

    // Apply on Enter key
    document.getElementById('filters-bar')?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') onFilter(getFilterValues());
    });
}

function getFilterValues() {
    return {
        vehicle_id: document.getElementById('filter-vehicle')?.value || '',
        from: document.getElementById('filter-from')?.value || '',
        to: document.getElementById('filter-to')?.value || '',
        trip_type: document.getElementById('filter-type')?.value || '',
        status: document.getElementById('filter-status')?.value || '',
        hide_parking: document.getElementById('filter-hide-parking')?.checked || false,
    };
}
