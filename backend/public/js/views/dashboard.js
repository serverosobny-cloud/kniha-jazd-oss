// Dashboard view
import { api } from '../api.js';
import { formatKm, formatNumber, formatDuration, getMonthRange, getLast7Days, formatDate } from '../utils.js';
import { showToast } from '../components/toast.js';
import { updateUnconfirmedBadge } from '../components/navbar.js';

export async function renderDashboard() {
    const content = document.getElementById('content');
    document.getElementById('page-title').textContent = 'Prehľad';
    document.getElementById('top-actions').innerHTML = '';

    content.innerHTML = '<div class="loading"><div class="spinner"></div> Načítavam...</div>';

    try {
        const month = getMonthRange();
        const week = getLast7Days();

        const [overview, timeline] = await Promise.all([
            api.getOverview(month),
            api.getTimeline({ from: week.from, to: week.to, groupBy: 'day' })
        ]);

        const totalTrips = parseInt(overview.total_trips || 0);
        const totalKm = parseFloat(overview.total_distance || 0) / 1000;
        const businessCount = parseInt(overview.business_trips || 0);
        const privateCount = parseInt(overview.private_trips || 0);
        const unconfCount = parseInt(overview.unconfirmed_trips || 0);
        const confirmedCount = parseInt(overview.confirmed_trips || 0);
        const businessKm = parseFloat(overview.business_distance || 0) / 1000;
        const privateKm = parseFloat(overview.private_distance || 0) / 1000;

        content.innerHTML = `
            <div class="stats-grid">
                <div class="stat-card">
                    <div class="stat-icon blue">&#128663;</div>
                    <div class="stat-info">
                        <h4>${formatNumber(totalTrips)}</h4>
                        <p>Jazdy tento mesiac</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon green">&#128739;</div>
                    <div class="stat-info">
                        <h4>${totalKm.toFixed(1)} km</h4>
                        <p>Celková vzdialenosť</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon orange">&#9200;</div>
                    <div class="stat-info">
                        <h4>${formatDuration(overview.total_duration)}</h4>
                        <p>Celkový čas</p>
                    </div>
                </div>
                <div class="stat-card">
                    <div class="stat-icon ${unconfCount > 0 ? 'red' : 'green'}">&#9888;</div>
                    <div class="stat-info">
                        <h4>${unconfCount}</h4>
                        <p>Nepotvrdených jázd</p>
                    </div>
                </div>
            </div>

            ${unconfCount > 0 ? `
                <div class="alert alert-warning">
                    &#9888; Máte <strong>${unconfCount}</strong> nepotvrdených jázd.
                    <a href="#/trips?status=UNCONFIRMED">Zobraziť</a>
                </div>
            ` : ''}

            <div class="quick-actions" style="margin-bottom: 24px;">
                <button class="quick-action-btn" id="btn-import-trips">
                    <div class="icon">&#128229;</div>
                    <div class="label">Importovať jazdy</div>
                </button>
                <button class="quick-action-btn" id="btn-recalc-km">
                    <div class="icon">&#128207;</div>
                    <div class="label">Prepočítať km</div>
                </button>
                ${unconfCount > 0 ? `
                <button class="quick-action-btn" id="btn-confirm-all">
                    <div class="icon">&#10004;</div>
                    <div class="label">Potvrdiť jazdy</div>
                </button>` : ''}
                <button class="quick-action-btn" onclick="location.hash='#/export'">
                    <div class="icon">&#128196;</div>
                    <div class="label">Exportovať</div>
                </button>
            </div>

            <div class="grid-2">
                <div class="card">
                    <div class="card-header">
                        <h3>Posledných 7 dní</h3>
                    </div>
                    <div id="timeline-chart" class="bar-chart">
                        ${renderBarChart(timeline, week)}
                    </div>
                </div>
                <div class="card">
                    <div class="card-header">
                        <h3>Typ jázd (tento mesiac)</h3>
                    </div>
                    <div style="display:flex;align-items:center;gap:24px;justify-content:center;padding:20px 0;">
                        ${renderDonutChart(businessCount, privateCount, unconfCount)}
                        <div class="chart-legend">
                            <div class="legend-item"><span class="legend-dot" style="background:var(--business)"></span> Služobné: ${businessCount} (${businessKm.toFixed(1)} km)</div>
                            <div class="legend-item"><span class="legend-dot" style="background:var(--private)"></span> Privátne: ${privateCount} (${privateKm.toFixed(1)} km)</div>
                            ${unconfCount > 0 ? `<div class="legend-item"><span class="legend-dot" style="background:var(--unconfirmed)"></span> Nepotvrdené: ${unconfCount}</div>` : ''}
                        </div>
                    </div>
                </div>
            </div>

            ${renderDataQuality(totalTrips, confirmedCount, unconfCount)}
        `;

        // Event listeners
        document.getElementById('btn-import-trips')?.addEventListener('click', async () => {
            try {
                showToast('Importujem jazdy...', 'info');
                const result = await api.importTrips();
                showToast(`Import dokončený: ${result.inserted} nových jázd`, 'success');
                updateUnconfirmedBadge();
                renderDashboard();
            } catch (e) {
                showToast('Chyba pri importe: ' + e.message, 'error');
            }
        });

        document.getElementById('btn-recalc-km')?.addEventListener('click', async () => {
            try {
                showToast('Prepočítavam vzdialenosti cez Google Routes...', 'info');
                const result = await api.recalculateDistances();
                const details = result.details || [];
                const changed = details.filter(d => d.old_km !== d.new_km);
                showToast(
                    `Prepočítané: ${result.recalculated} jázd, ${changed.length} zmenených (${result.api_calls} API volaní)`,
                    'success'
                );
                renderDashboard();
            } catch (e) {
                showToast('Chyba: ' + e.message, 'error');
            }
        });

        document.getElementById('btn-confirm-all')?.addEventListener('click', () => {
            location.hash = '#/trips?status=UNCONFIRMED';
        });

    } catch (err) {
        content.innerHTML = `<div class="alert alert-danger">Chyba pri načítaní: ${err.message}</div>`;
    }
}

function renderBarChart(timeline, week) {
    const days = ['Ne', 'Po', 'Ut', 'St', 'Št', 'Pi', 'So'];

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const allDays = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(today.getDate() - i);
        const dateStr = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        const found = timeline?.find(t => t.period && t.period.substring(0, 10) === dateStr);
        const isToday = i === 0;
        allDays.push({
            date: d,
            label: isToday ? 'Dnes' : days[d.getDay()],
            total: found ? parseFloat(found.total_distance || 0) : 0,
            business: found ? parseFloat(found.business_distance || 0) : 0,
            private: found ? parseFloat(found.private_distance || 0) : 0,
            trips: found ? parseInt(found.trips_count || 0) : 0,
            isToday
        });
    }

    const maxDist = Math.max(...allDays.map(d => d.total), 1);

    const bars = allDays.map(day => {
        const totalHeight = maxDist > 0 ? Math.max((day.total / maxDist) * 100, day.trips > 0 ? 4 : 2) : 2;
        const businessPct = day.total > 0 ? (day.business / day.total) * 100 : 0;
        const privatePct = day.total > 0 ? (day.private / day.total) * 100 : 0;
        const km = (day.total / 1000).toFixed(0);
        const todayStyle = day.isToday ? 'outline:2px solid var(--secondary);outline-offset:1px' : '';

        return `
            <div class="bar-item">
                <div class="bar-value">${km > 0 ? km + 'km' : ''}</div>
                <div class="bar-stack" style="height:${totalHeight}%;${todayStyle}">
                    ${day.trips > 0 ? `
                        <div class="bar-segment" style="height:${businessPct}%;background:var(--business)" title="Služobné: ${(day.business/1000).toFixed(0)} km"></div>
                        <div class="bar-segment" style="height:${privatePct}%;background:var(--private)" title="Privátne: ${(day.private/1000).toFixed(0)} km"></div>
                    ` : `
                        <div class="bar-segment" style="height:100%;background:var(--border)"></div>
                    `}
                </div>
                <div class="bar-label" style="${day.isToday ? 'font-weight:700;color:var(--primary)' : ''}">${day.label}</div>
            </div>
        `;
    }).join('');

    const legend = `
        <div style="display:flex;gap:12px;justify-content:center;margin-top:8px;font-size:11px;color:var(--text-muted)">
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--business);vertical-align:middle;margin-right:3px"></span>Služobné</span>
            <span><span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:var(--private);vertical-align:middle;margin-right:3px"></span>Privátne</span>
        </div>
    `;

    return bars + legend;
}

function renderDonutChart(business, privateTrips, unconfirmed) {
    const total = business + privateTrips + unconfirmed;
    if (total === 0) {
        return '<div class="empty-state" style="padding:20px"><p>Žiadne jazdy</p></div>';
    }

    const pBusiness = (business / total) * 100;
    const pPrivate = (privateTrips / total) * 100;
    const pUnconf = (unconfirmed / total) * 100;

    let gradient = `conic-gradient(`;
    let offset = 0;
    const segments = [
        { pct: pBusiness, color: 'var(--business)' },
        { pct: pPrivate, color: 'var(--private)' },
        { pct: pUnconf, color: 'var(--unconfirmed)' },
    ].filter(s => s.pct > 0);

    segments.forEach((seg, i) => {
        gradient += `${seg.color} ${offset}% ${offset + seg.pct}%`;
        offset += seg.pct;
        if (i < segments.length - 1) gradient += ', ';
    });
    gradient += ')';

    return `
        <div class="donut-chart" style="background:${gradient}">
            <div class="donut-center">
                <strong>${total}</strong>
                <small>jázd</small>
            </div>
        </div>
    `;
}

function renderDataQuality(totalTrips, confirmedCount, unconfCount) {
    if (totalTrips === 0) return '';

    const confirmedPct = Math.round((confirmedCount / totalTrips) * 100);

    return `
        <div class="card" style="margin-top:16px">
            <div class="card-header">
                <h3>Kvalita dát</h3>
            </div>
            <div style="display:flex;gap:24px;flex-wrap:wrap;align-items:center">
                <div>
                    <div style="font-size:14px;margin-bottom:4px">Potvrdené jazdy</div>
                    <div style="background:var(--border);border-radius:4px;height:8px;width:200px;overflow:hidden">
                        <div style="background:${confirmedPct >= 80 ? 'var(--success)' : confirmedPct >= 50 ? 'var(--warning)' : 'var(--danger)'};height:100%;width:${confirmedPct}%;border-radius:4px"></div>
                    </div>
                    <div style="font-size:12px;color:var(--text-muted);margin-top:2px">${confirmedPct}% (${confirmedCount}/${totalTrips})</div>
                </div>
                ${unconfCount > 0 ? `
                <div class="alert alert-warning" style="margin:0;flex:1">
                    &#9888; ${unconfCount} nepotvrdených jázd
                </div>
                ` : `
                <div class="alert alert-success" style="margin:0;flex:1">
                    &#10004; Všetky jazdy sú potvrdené
                </div>
                `}
            </div>
        </div>
    `;
}
