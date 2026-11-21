// Utility functions for Kniha jázd

export function formatDate(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleDateString('sk-SK', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleDateString('sk-SK', {
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
    });
}

export function formatTime(dateStr) {
    if (!dateStr) return '-';
    const d = new Date(dateStr);
    return d.toLocaleTimeString('sk-SK', { hour: '2-digit', minute: '2-digit' });
}

export function formatKm(meters) {
    if (meters === null || meters === undefined) return '0 km';
    const km = parseFloat(meters) / 1000;
    if (km < 1) return `${Math.round(parseFloat(meters))} m`;
    return `${km.toFixed(1)} km`;
}

export function formatDuration(seconds) {
    if (!seconds) return '-';
    seconds = parseInt(seconds);
    if (seconds < 60) return `${seconds}s`;
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (h > 0) return `${h}h ${m}min`;
    return `${m} min`;
}

export function formatNumber(n) {
    if (n === null || n === undefined) return '0';
    return parseInt(n).toLocaleString('sk-SK');
}

export function tripTypeLabel(type) {
    const labels = {
        business: 'Služobná',
        private: 'Privátna',
        unconfirmed: 'Nepotvrdená'
    };
    return labels[type] || type;
}

export function tripTypeBadge(type) {
    return `<span class="badge badge-${type}">${tripTypeLabel(type)}</span>`;
}

export function statusBadge(status) {
    const labels = { UNCONFIRMED: 'Nepotvrdená', CONFIRMED: 'Potvrdená', LOCKED: 'Zamknutá' };
    const classes = { UNCONFIRMED: 'unconfirmed', CONFIRMED: 'confirmed', LOCKED: 'locked' };
    return `<span class="badge badge-${classes[status] || 'unconfirmed'}">${labels[status] || status}</span>`;
}

export function truncateAddress(addr, maxLen = 30) {
    if (!addr) return '-';
    return addr.length > maxLen ? addr.substring(0, maxLen) + '...' : addr;
}

export function getMonthRange(offset = 0) {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth() + offset, 1);
    const end = new Date(now.getFullYear(), now.getMonth() + offset + 1, 0);
    return {
        from: start.toISOString().split('T')[0],
        to: end.toISOString().split('T')[0]
    };
}

export function getWeekRange(offset = 0) {
    const now = new Date();
    const dayOfWeek = now.getDay() || 7;
    const start = new Date(now);
    start.setDate(now.getDate() - dayOfWeek + 1 + offset * 7);
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    return {
        from: start.toISOString().split('T')[0],
        to: end.toISOString().split('T')[0]
    };
}

export function getLast7Days() {
    const to = new Date();
    const from = new Date(to);
    from.setDate(to.getDate() - 6); // 6 days back + today = 7 days, today is last
    return {
        from: from.toISOString().split('T')[0],
        to: to.toISOString().split('T')[0]
    };
}

/**
 * Haversine distance between two GPS coordinates in meters
 */
export function haversineDistance(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

export function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

export function escapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

export function el(tag, attrs = {}, ...children) {
    const element = document.createElement(tag);
    Object.entries(attrs).forEach(([key, value]) => {
        if (key === 'className') element.className = value;
        else if (key === 'innerHTML') element.innerHTML = value;
        else if (key.startsWith('on')) element.addEventListener(key.slice(2).toLowerCase(), value);
        else if (key === 'dataset') Object.entries(value).forEach(([k, v]) => element.dataset[k] = v);
        else element.setAttribute(key, value);
    });
    children.forEach(child => {
        if (typeof child === 'string') element.appendChild(document.createTextNode(child));
        else if (child) element.appendChild(child);
    });
    return element;
}
