// Sidebar navigation component
import { api } from '../api.js';

const navItems = [
    { hash: '#/dashboard', icon: '&#9632;', label: 'Prehľad' },
    { hash: '#/trips', icon: '&#9654;', label: 'Jazdy', badgeId: 'unconfirmed-badge' },
    { hash: '#/vehicles', icon: '&#9881;', label: 'Vozidlá' },
    { hash: '#/waypoints', icon: '&#128205;', label: 'Miesta' },
    { hash: '#/settings', icon: '&#9881;', label: 'Nastavenia' },
    { hash: '#/export', icon: '&#8681;', label: 'Export' },
];

export function renderNavbar() {
    const menu = document.getElementById('nav-menu');
    menu.innerHTML = navItems.map(item => `
        <li class="nav-item">
            <a href="${item.hash}" data-route="${item.hash}">
                <span class="nav-icon">${item.icon}</span>
                <span>${item.label}</span>
                ${item.badgeId ? `<span class="nav-badge" id="${item.badgeId}" style="display:none">0</span>` : ''}
            </a>
        </li>
    `).join('');

    // Hamburger toggle
    document.getElementById('hamburger').addEventListener('click', () => {
        document.getElementById('sidebar').classList.toggle('open');
    });

    document.getElementById('sidebar-close').addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
    });

    // Close sidebar on navigation (mobile)
    menu.addEventListener('click', () => {
        document.getElementById('sidebar').classList.remove('open');
    });

    updateUnconfirmedBadge();
}

export function setActiveNav(hash) {
    document.querySelectorAll('.nav-item a').forEach(a => {
        a.classList.toggle('active', a.dataset.route === hash);
    });
}

export async function updateUnconfirmedBadge() {
    try {
        const result = await api.getUnconfirmedTrips();
        const badge = document.getElementById('unconfirmed-badge');
        if (badge) {
            const count = result.count || 0;
            badge.textContent = count;
            badge.style.display = count > 0 ? '' : 'none';
        }
    } catch (e) {
        // silently fail
    }
}
