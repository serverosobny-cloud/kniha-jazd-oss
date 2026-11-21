// App - Router and initialization
import { renderNavbar, setActiveNav } from './components/navbar.js';
import { renderDashboard } from './views/dashboard.js';
import { renderTrips } from './views/trips.js';
import { renderTripDetail } from './views/trip-detail.js';
import { renderVehicles } from './views/vehicles.js';
import { renderSettings } from './views/settings.js';
import { renderExport } from './views/export.js';
import { renderWaypoints } from './views/waypoints.js?v=6';

// Clean up keyboard handlers on route change
function cleanupHandlers() {
    if (window._tripsKeyHandler) {
        document.removeEventListener('keydown', window._tripsKeyHandler);
        window._tripsKeyHandler = null;
    }
}

// Router
function route() {
    cleanupHandlers();
    const hash = location.hash || '#/dashboard';
    const path = hash.split('?')[0];

    // Set active nav
    const baseRoute = '#/' + (path.split('/')[1] || 'dashboard');
    setActiveNav(baseRoute);

    // Route matching
    if (path === '#/dashboard' || path === '#/' || path === '') {
        renderDashboard();
    } else if (path.match(/^#\/trips\/(\d+)$/)) {
        const id = path.match(/^#\/trips\/(\d+)$/)[1];
        renderTripDetail(parseInt(id));
    } else if (path === '#/trips') {
        renderTrips();
    } else if (path === '#/vehicles') {
        renderVehicles();
    } else if (path === '#/settings') {
        renderSettings();
    } else if (path === '#/waypoints') {
        renderWaypoints();
    } else if (path === '#/export') {
        renderExport();
    } else {
        renderDashboard();
    }
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    renderNavbar();

    // Default route
    if (!location.hash) {
        location.hash = '#/dashboard';
    }

    route();
});

window.addEventListener('hashchange', route);
