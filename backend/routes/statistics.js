const express = require('express');
const router = express.Router();
const db = require('../db');

/**
 * Zostaví dátumový filter pre trips
 * Vždy vylúči merged tripy a voliteľne parkování
 */
function buildFilter(from, to, { alias = '', includeParkingFilter = true } = {}) {
    const prefix = alias ? `${alias}.` : '';
    const conditions = [`${prefix}merged_into_id IS NULL`];
    const params = [];
    let idx = 1;

    if (from) {
        params.push(from);
        conditions.push(`${prefix}start_time >= $${idx++}::date`);
    }
    if (to) {
        // Koniec dňa: ak je to len dátum, pridaj +1 deň
        params.push(to);
        conditions.push(`${prefix}start_time < ($${idx++}::date + interval '1 day')`);
    }

    return { where: conditions.join(' AND '), params };
}

// Celkové štatistiky
router.get('/overview', async (req, res) => {
    try {
        const { from, to, vehicle_id } = req.query;
        const { where, params } = buildFilter(from, to);

        let extraFilter = '';
        if (vehicle_id) {
            params.push(vehicle_id);
            extraFilter = ` AND vehicle_id = $${params.length}`;
        }

        const result = await db.query(`
            SELECT
                COUNT(*) as total_trips,
                COALESCE(SUM(distance_meters), 0) as total_distance,
                COALESCE(SUM(duration_seconds), 0) as total_duration,
                COALESCE(AVG(distance_meters), 0) as avg_distance,
                COUNT(DISTINCT vehicle_id) as active_vehicles,
                COUNT(DISTINCT driver_id) as active_drivers,
                COUNT(*) FILTER (WHERE trip_type = 'business') as business_trips,
                COUNT(*) FILTER (WHERE trip_type = 'private') as private_trips,
                COUNT(*) FILTER (WHERE trip_type = 'commute') as commute_trips,
                COUNT(*) FILTER (WHERE status = 'UNCONFIRMED') as unconfirmed_trips,
                COUNT(*) FILTER (WHERE status = 'CONFIRMED') as confirmed_trips,
                COALESCE(SUM(distance_meters) FILTER (WHERE trip_type = 'business'), 0) as business_distance,
                COALESCE(SUM(distance_meters) FILTER (WHERE trip_type = 'private'), 0) as private_distance,
                COALESCE(SUM(distance_meters) FILTER (WHERE trip_type = 'commute'), 0) as commute_distance
            FROM trips
            WHERE ${where}${extraFilter}
        `, params);

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Štatistiky podľa vozidiel
router.get('/by-vehicle', async (req, res) => {
    try {
        const { from, to } = req.query;
        const { where, params } = buildFilter(from, to, { alias: 't' });

        const result = await db.query(`
            SELECT
                v.id,
                v.name,
                v.registration_plate,
                COUNT(t.id) as trips_count,
                COALESCE(SUM(t.distance_meters), 0) as total_distance,
                COALESCE(SUM(t.duration_seconds), 0) as total_duration,
                COALESCE(AVG(t.distance_meters), 0) as avg_distance,
                COUNT(t.id) FILTER (WHERE t.trip_type = 'business') as business_trips,
                COUNT(t.id) FILTER (WHERE t.trip_type = 'private') as private_trips
            FROM vehicles v
            LEFT JOIN trips t ON v.id = t.vehicle_id AND ${where}
            GROUP BY v.id, v.name, v.registration_plate
            ORDER BY total_distance DESC NULLS LAST
        `, params);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Štatistiky podľa vodičov
router.get('/by-driver', async (req, res) => {
    try {
        const { from, to } = req.query;
        const { where, params } = buildFilter(from, to, { alias: 't' });

        const result = await db.query(`
            SELECT
                d.id,
                CONCAT(d.first_name, ' ', d.last_name) as driver_name,
                COUNT(t.id) as trips_count,
                COALESCE(SUM(t.distance_meters), 0) as total_distance,
                COALESCE(SUM(t.duration_seconds), 0) as total_duration,
                COALESCE(AVG(t.distance_meters), 0) as avg_distance
            FROM drivers d
            LEFT JOIN trips t ON d.id = t.driver_id AND ${where}
            GROUP BY d.id, driver_name
            ORDER BY total_distance DESC NULLS LAST
        `, params);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Štatistiky podľa účelu
router.get('/by-purpose', async (req, res) => {
    try {
        const { from, to } = req.query;
        const { where, params } = buildFilter(from, to);

        const result = await db.query(`
            SELECT
                COALESCE(trip_purpose, 'Neuvedené') as trip_purpose,
                trip_type,
                COUNT(*) as trips_count,
                COALESCE(SUM(distance_meters), 0) as total_distance,
                COALESCE(SUM(duration_seconds), 0) as total_duration
            FROM trips
            WHERE ${where}
            GROUP BY trip_purpose, trip_type
            ORDER BY total_distance DESC
        `, params);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Štatistiky podľa dní/mesiacov
router.get('/timeline', async (req, res) => {
    try {
        const { from, to, groupBy = 'day' } = req.query;
        const { where, params } = buildFilter(from, to);

        const dateGroup = groupBy === 'month'
            ? "DATE_TRUNC('month', start_time)"
            : "DATE_TRUNC('day', start_time)";

        const result = await db.query(`
            SELECT
                ${dateGroup} as period,
                COUNT(*) as trips_count,
                COALESCE(SUM(distance_meters), 0) as total_distance,
                COALESCE(SUM(duration_seconds), 0) as total_duration,
                COUNT(*) FILTER (WHERE trip_type = 'business') as business_trips,
                COUNT(*) FILTER (WHERE trip_type = 'private') as private_trips,
                COALESCE(SUM(distance_meters) FILTER (WHERE trip_type = 'business'), 0) as business_distance,
                COALESCE(SUM(distance_meters) FILTER (WHERE trip_type = 'private'), 0) as private_distance
            FROM trips
            WHERE ${where}
            GROUP BY period
            ORDER BY period
        `, params);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
