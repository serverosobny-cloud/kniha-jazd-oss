// API Client for Kniha jázd
const API_BASE = '/api';

async function request(endpoint, options = {}) {
    const url = `${API_BASE}${endpoint}`;
    const config = {
        headers: { 'Content-Type': 'application/json' },
        ...options
    };

    if (config.body && typeof config.body === 'object') {
        config.body = JSON.stringify(config.body);
    }

    const response = await fetch(url, config);

    if (!response.ok) {
        // Handle file downloads
        if (response.headers.get('content-type')?.includes('application/pdf') ||
            response.headers.get('content-type')?.includes('text/csv')) {
            return response;
        }
        const error = await response.json().catch(() => ({ error: 'Chyba servera' }));
        throw new Error(error.error || error.message || `HTTP ${response.status}`);
    }

    const contentType = response.headers.get('content-type');
    if (contentType?.includes('application/json')) {
        return response.json();
    }
    return response;
}

export const api = {
    // Vehicles
    getVehicles: () => request('/vehicles'),
    getVehicle: (id) => request(`/vehicles/${id}`),
    createVehicle: (data) => request('/vehicles', { method: 'POST', body: data }),
    updateVehicle: (id, data) => request(`/vehicles/${id}`, { method: 'PUT', body: data }),
    deleteVehicle: (id) => request(`/vehicles/${id}`, { method: 'DELETE' }),
    getVehicleDevices: (id) => request(`/vehicles/${id}/devices`),
    addVehicleDevice: (id, data) => request(`/vehicles/${id}/devices`, { method: 'POST', body: data }),
    removeVehicleDevice: (vehicleId, deviceId) => request(`/vehicles/${vehicleId}/devices/${deviceId}`, { method: 'DELETE' }),

    // Drivers
    getDrivers: () => request('/drivers'),
    getDriver: (id) => request(`/drivers/${id}`),
    createDriver: (data) => request('/drivers', { method: 'POST', body: data }),
    updateDriver: (id, data) => request(`/drivers/${id}`, { method: 'PUT', body: data }),
    deleteDriver: (id) => request(`/drivers/${id}`, { method: 'DELETE' }),

    // Trips
    getTrips: (params = {}) => {
        const qs = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => { if (v !== undefined && v !== '' && v !== null) qs.set(k, v); });
        return request(`/trips?${qs}`);
    },
    getTrip: (id) => request(`/trips/${id}`),
    getUnconfirmedTrips: (params = {}) => {
        const qs = new URLSearchParams(params);
        return request(`/trips/unconfirmed?${qs}`);
    },
    createTrip: (data) => request('/trips', { method: 'POST', body: data }),
    updateTrip: (id, data) => request(`/trips/${id}`, { method: 'PUT', body: data }),
    deleteTrip: (id) => request(`/trips/${id}`, { method: 'DELETE', body: {} }),
    confirmTrip: (id, data = {}) => request(`/trips/${id}/confirm`, { method: 'POST', body: data }),
    suggestClassification: (id) => request(`/trips/${id}/suggest-classification`, { method: 'POST' }),
    getTripAudit: (id) => request(`/trips/${id}/audit`),
    splitTrip: (id) => request(`/trips/${id}/split`, { method: 'POST' }),
    bulkConfirm: (tripIds) => request('/trips/bulk-confirm', { method: 'POST', body: { trip_ids: tripIds } }),
    bulkConfirmWithData: (tripIds, data) => request('/trips/bulk-confirm', { method: 'POST', body: data }),
    bulkUpdate: (tripIds, data) => request('/trips/bulk-update', { method: 'POST', body: { trip_ids: tripIds, ...data } }),
    getPurposeTemplates: () => request('/trips/purpose-templates'),
    recalculateDistances: (tripIds = null) => request('/trips/recalculate-distances', {
        method: 'POST',
        body: tripIds ? { trip_ids: tripIds } : {}
    }),
    getTripPositions: (id, step = 1) => request(`/trips/${id}/positions?step=${step}`),

    // Import
    importTrips: (data = {}) => request('/import/trips', { method: 'POST', body: data }),
    importPositions: (data = {}) => request('/import/positions', { method: 'POST', body: data }),
    syncDevices: () => request('/import/sync-devices', { method: 'POST' }),
    getImportHistory: (limit = 20) => request(`/import/history?limit=${limit}`),

    // Statistics
    getOverview: (params = {}) => {
        const qs = new URLSearchParams();
        Object.entries(params).forEach(([k, v]) => { if (v) qs.set(k, v); });
        return request(`/statistics/overview?${qs}`);
    },
    getStatsByVehicle: (params = {}) => {
        const qs = new URLSearchParams(params);
        return request(`/statistics/by-vehicle?${qs}`);
    },
    getTimeline: (params = {}) => {
        const qs = new URLSearchParams(params);
        return request(`/statistics/timeline?${qs}`);
    },

    // Geofence
    getZones: () => request('/geofence/zones'),
    getZone: (id) => request(`/geofence/zones/${id}`),
    createZone: (data) => request('/geofence/zones', { method: 'POST', body: data }),
    updateZone: (id, data) => request(`/geofence/zones/${id}`, { method: 'PUT', body: data }),
    deleteZone: (id) => request(`/geofence/zones/${id}`, { method: 'DELETE' }),
    getRules: () => request('/geofence/rules'),
    createRule: (data) => request('/geofence/rules', { method: 'POST', body: data }),
    updateRule: (id, data) => request(`/geofence/rules/${id}`, { method: 'PUT', body: data }),
    deleteRule: (id) => request(`/geofence/rules/${id}`, { method: 'DELETE' }),

    // Periods & Export
    getPeriodLocks: () => request('/periods/locks'),
    lockPeriod: (data) => request('/periods/lock', { method: 'POST', body: data }),
    unlockPeriod: (data) => request('/periods/unlock', { method: 'POST', body: data }),
    checkLockable: (params) => {
        const qs = new URLSearchParams(params);
        return request(`/periods/check-lockable?${qs}`);
    },
    exportCsv: async (data) => {
        const response = await fetch(`${API_BASE}/periods/csv`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Export failed' }));
            throw new Error(err.error || 'Export failed');
        }
        return response;
    },
    exportPdf: async (data) => {
        const response = await fetch(`${API_BASE}/periods/pdf`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });
        if (!response.ok) {
            const err = await response.json().catch(() => ({ error: 'Export failed' }));
            throw new Error(err.error || 'Export failed');
        }
        return response;
    },
    getExportHistory: () => request('/periods/history'),

    // Places (Google Places integration)
    getPlacesApiKey: () => request('/places/api-key'),
    getSavedPlaces: () => request('/places/saved'),
    savePlace: (data) => request('/places/saved', { method: 'POST', body: data }),
    deleteSavedPlace: (id) => request(`/places/saved/${id}`, { method: 'DELETE' }),
    findNearestPositions: (date, waypoints) => request('/places/find-nearest', {
        method: 'POST',
        body: { date, waypoints }
    }),
    splitByWaypoints: (date, waypoints) => request('/places/split-by-waypoints', {
        method: 'POST',
        body: { date, waypoints }
    }),
};
