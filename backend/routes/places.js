const express = require('express');
const router = express.Router();
const db = require('../db');

/**
 * POST /api/places/find-nearest - Nájsť najbližšie GPS pozície k waypoints
 */
router.post('/find-nearest', async (req, res) => {
    const { date, waypoints } = req.body;
    if (!date || !waypoints?.length) {
        return res.status(400).json({ error: 'date a waypoints sú povinné' });
    }

    try {
        const results = [];
        let minTime = null; // Each next waypoint must have GPS time AFTER previous

        for (let i = 0; i < waypoints.length; i++) {
            const wp = waypoints[i];

            // Manual waypoint - skip GPS search, don't advance minTime
            if (wp.manual) {
                results.push({
                    order: i,
                    waypoint: wp,
                    nearest_time: null,
                    nearest_lat: null,
                    nearest_lon: null,
                    distance_m: null,
                    device_id: null,
                    has_gps: false,
                    manual: true
                });
                continue;
            }

            const params = [wp.latitude, wp.longitude, date];
            let timeFilter = '';
            if (minTime) {
                timeFilter = 'AND device_time > $4';
                params.push(minTime);
            }

            // Find EARLIEST position within 3km (not nearest by distance)
            // This ensures chronological order matches waypoint order
            const posResult = await db.query(
                `SELECT * FROM (
                    SELECT traccar_id, device_id, device_time, latitude, longitude, speed,
                           (6371000 * acos(LEAST(1.0, cos(radians($1)) * cos(radians(latitude)) *
                            cos(radians(longitude) - radians($2)) + sin(radians($1)) *
                            sin(radians(latitude))))) as distance_m
                    FROM positions
                    WHERE device_time::date = $3 ${timeFilter}
                 ) sub
                 WHERE distance_m < 200
                 ORDER BY device_time ASC
                 LIMIT 1`,
                params
            );

            if (posResult.rows.length > 0) {
                const nearest = posResult.rows[0];
                const distM = parseFloat(nearest.distance_m);
                minTime = nearest.device_time; // Advance time window
                results.push({
                    order: i,
                    waypoint: wp,
                    nearest_time: nearest.device_time,
                    nearest_lat: parseFloat(nearest.latitude),
                    nearest_lon: parseFloat(nearest.longitude),
                    distance_m: Math.round(distM),
                    device_id: nearest.device_id,
                    has_gps: true
                });
            } else {
                results.push({
                    order: i,
                    waypoint: wp,
                    nearest_time: null,
                    nearest_lat: null,
                    nearest_lon: null,
                    distance_m: null,
                    device_id: null,
                    has_gps: false
                });
            }
        }

        res.json({ results });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/places/api-key - Vrátiť API kľúč pre frontend
 */
router.get('/api-key', (req, res) => {
    const key = process.env.GOOGLE_PLACES_API_KEY;
    if (!key) {
        return res.status(500).json({ error: 'GOOGLE_PLACES_API_KEY nie je nakonfigurovaný' });
    }
    res.json({ key });
});

/**
 * GET /api/places/saved - Zoznam uložených miest
 */
router.get('/saved', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM saved_places ORDER BY use_count DESC, last_used_at DESC'
        );
        res.json({ places: result.rows });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/places/saved - Uložiť miesto
 */
router.post('/saved', async (req, res) => {
    const { google_place_id, name, address, latitude, longitude, place_type } = req.body;
    if (!name || !latitude || !longitude) {
        return res.status(400).json({ error: 'name, latitude, longitude sú povinné' });
    }
    try {
        const result = await db.query(
            `INSERT INTO saved_places (google_place_id, name, address, latitude, longitude, place_type)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (google_place_id) DO UPDATE SET
                use_count = saved_places.use_count + 1,
                last_used_at = NOW()
             RETURNING *`,
            [google_place_id || null, name, address, latitude, longitude, place_type]
        );
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/places/saved/:id - Zmazať uložené miesto
 */
router.delete('/saved/:id', async (req, res) => {
    try {
        await db.query('DELETE FROM saved_places WHERE id = $1', [req.params.id]);
        res.json({ ok: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * POST /api/places/split-by-waypoints - Vytvoriť jazdy podľa navštívených miest
 *
 * Logika:
 * - Poradie waypointov je sväté (definuje trasu dňa)
 * - Pre každú dvojicu (WP[i] → WP[i+1]) hľadáme GPS dáta
 * - Ak GPS existuje: vytvoríme jazdu s reálnou vzdialenosťou
 * - Ak GPS chýba: vytvoríme manuálnu jazdu s odhadom (vzdušná vzdialenosť * 1.3)
 * - Existujúce overlapping jazdy sa skryjú (merged_into_id)
 */
router.post('/split-by-waypoints', async (req, res) => {
    const { date, waypoints } = req.body;
    if (!date || !waypoints?.length || waypoints.length < 2) {
        return res.status(400).json({ error: 'Treba aspoň 2 waypoints' });
    }

    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // 1. Get vehicle_id from existing trips
        const vehicleResult = await client.query(
            `SELECT DISTINCT vehicle_id FROM trips
             WHERE start_time::date = $1 AND merged_into_id IS NULL AND is_parking = false
             LIMIT 1`,
            [date]
        );
        const vehicleId = vehicleResult.rows[0]?.vehicle_id;
        if (!vehicleId) {
            await client.query('ROLLBACK');
            return res.json({ message: 'Žiadne jazdy na tento deň', segments: 0 });
        }

        // 2. Get ALL GPS positions for the date
        const allPosResult = await client.query(
            `SELECT traccar_id as id, device_id, device_time, latitude, longitude, speed, address
             FROM positions WHERE device_time::date = $1 ORDER BY device_time`,
            [date]
        );
        const allPositions = allPosResult.rows;

        // 3. For each waypoint (in USER order), find EARLIEST GPS position within 3km
        //    Manual waypoints skip GPS search and don't advance minTime
        //    Positions are already sorted by device_time ASC
        const wpData = [];
        let minTime = null;
        for (let wi = 0; wi < waypoints.length; wi++) {
            const wp = waypoints[wi];

            // Manual waypoint - skip GPS, don't advance time
            if (wp.manual) {
                wpData.push({
                    waypoint: wp,
                    gpsPos: null,
                    gpsTime: null,
                    gpsDist: null,
                    hasGps: false
                });
                continue;
            }

            let bestPos = null;
            let bestDist = null;
            for (const pos of allPositions) {
                if (minTime && new Date(pos.device_time) <= minTime) continue;
                const d = haversine(pos.latitude, pos.longitude, wp.latitude, wp.longitude);
                if (d < 200) {
                    bestPos = pos;
                    bestDist = d;
                    break;
                }
            }
            const hasGps = bestPos != null;
            if (hasGps) {
                minTime = new Date(bestPos.device_time); // Advance time window
            }
            wpData.push({
                waypoint: wp,
                gpsPos: hasGps ? bestPos : null,
                gpsTime: hasGps ? new Date(bestPos.device_time) : null,
                gpsDist: hasGps ? Math.round(bestDist) : null,
                hasGps
            });
        }

        // 4. Build segments between consecutive waypoints (in USER order)
        const createdTrips = [];
        const createdStops = [];
        const manualSegments = [];

        for (let i = 0; i < wpData.length - 1; i++) {
            const from = wpData[i];
            const to = wpData[i + 1];

            const fromName = from.waypoint.name || from.waypoint.address || `Bod ${i + 1}`;
            const toName = to.waypoint.name || to.waypoint.address || `Bod ${i + 2}`;

            // Calculate straight-line distance between waypoints
            const straightDist = haversine(from.waypoint.latitude, from.waypoint.longitude,
                                           to.waypoint.latitude, to.waypoint.longitude);

            // Auto-classify via geofence zones
            const fromLat = from.hasGps ? from.gpsPos.latitude : from.waypoint.latitude;
            const fromLon = from.hasGps ? from.gpsPos.longitude : from.waypoint.longitude;
            const toLat = to.hasGps ? to.gpsPos.latitude : to.waypoint.latitude;
            const toLon = to.hasGps ? to.gpsPos.longitude : to.waypoint.longitude;

            let autoType = 'unconfirmed';
            let autoPurpose = null;
            let startZoneId = null;
            let endZoneId = null;

            try {
                const szResult = await client.query('SELECT find_geofence_zone($1, $2) as zone_id', [fromLat, fromLon]);
                startZoneId = szResult.rows[0]?.zone_id || null;
                const ezResult = await client.query('SELECT find_geofence_zone($1, $2) as zone_id', [toLat, toLon]);
                endZoneId = ezResult.rows[0]?.zone_id || null;

                if (startZoneId || endZoneId) {
                    const classResult = await client.query('SELECT * FROM suggest_trip_classification($1, $2)', [startZoneId, endZoneId]);
                    if (classResult.rows[0]?.suggested_type) {
                        autoType = classResult.rows[0].suggested_type;
                        autoPurpose = classResult.rows[0].suggested_purpose || null;
                    }
                }
            } catch (e) { /* ignore classification errors */ }

            if (from.hasGps && to.hasGps) {
                // Both have GPS - calculate real distance from positions between the two times
                const fromTime = from.gpsTime;
                const toTime = to.gpsTime;
                const startTime = fromTime < toTime ? fromTime : toTime;
                const endTime = fromTime < toTime ? toTime : fromTime;

                // Get positions between these two times
                const segPositions = allPositions.filter(p => {
                    const t = new Date(p.device_time);
                    return t >= startTime && t <= endTime;
                });

                let realDist = 0;
                if (segPositions.length >= 2) {
                    for (let j = 1; j < segPositions.length; j++) {
                        realDist += haversine(
                            segPositions[j - 1].latitude, segPositions[j - 1].longitude,
                            segPositions[j].latitude, segPositions[j].longitude
                        );
                    }
                } else {
                    realDist = straightDist * 1.3; // estimate
                }

                const durSec = Math.round((endTime - startTime) / 1000);

                const result = await client.query(
                    `INSERT INTO trips (
                        vehicle_id, start_time, end_time,
                        start_latitude, start_longitude, end_latitude, end_longitude,
                        start_address, end_address,
                        distance_meters, duration_seconds,
                        trip_type, status, trip_purpose, start_zone_id, end_zone_id, internal_notes
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'UNCONFIRMED',$13,$14,$15,$16)
                    RETURNING id`,
                    [
                        vehicleId, startTime, endTime,
                        from.gpsPos.latitude, from.gpsPos.longitude,
                        to.gpsPos.latitude, to.gpsPos.longitude,
                        fromName, toName,
                        Math.round(realDist), durSec, autoType,
                        autoPurpose, startZoneId, endZoneId,
                        'Vytvorené podľa navštívených miest (GPS)'
                    ]
                );
                createdTrips.push({
                    id: result.rows[0].id, from: fromName, to: toName, dist: Math.round(realDist), manual: false,
                    from_lat: from.gpsPos.latitude, from_lon: from.gpsPos.longitude,
                    to_lat: to.gpsPos.latitude, to_lon: to.gpsPos.longitude
                });
            } else {
                // Missing GPS for at least one waypoint - create manual entry
                // Estimate time: if we have one GPS time, use it; otherwise estimate from position in day
                let startTime, endTime;

                if (from.hasGps && !to.hasGps) {
                    startTime = from.gpsTime;
                    // Estimate arrival: ~50km/h average
                    const estMinutes = Math.max(5, Math.round(straightDist / 1000 / 50 * 60));
                    endTime = new Date(startTime.getTime() + estMinutes * 60000);
                } else if (!from.hasGps && to.hasGps) {
                    endTime = to.gpsTime;
                    const estMinutes = Math.max(5, Math.round(straightDist / 1000 / 50 * 60));
                    startTime = new Date(endTime.getTime() - estMinutes * 60000);
                } else {
                    // Neither has GPS - use rough time estimates based on position in sequence
                    const baseTime = new Date(date + 'T06:00:00');
                    startTime = new Date(baseTime.getTime() + i * 30 * 60000);
                    endTime = new Date(startTime.getTime() + 30 * 60000);
                }

                const estDist = Math.round(straightDist * 1.3);
                const durSec = Math.round((endTime - startTime) / 1000);

                const result = await client.query(
                    `INSERT INTO trips (
                        vehicle_id, start_time, end_time,
                        start_latitude, start_longitude, end_latitude, end_longitude,
                        start_address, end_address,
                        distance_meters, duration_seconds,
                        trip_type, status, trip_purpose, start_zone_id, end_zone_id, internal_notes
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'UNCONFIRMED',$13,$14,$15,$16)
                    RETURNING id`,
                    [
                        vehicleId, startTime, endTime,
                        from.waypoint.latitude, from.waypoint.longitude,
                        to.waypoint.latitude, to.waypoint.longitude,
                        fromName, toName,
                        estDist, durSec, autoType,
                        autoPurpose, startZoneId, endZoneId,
                        'Manuálne - chýbajúce GPS dáta'
                    ]
                );
                createdTrips.push({
                    id: result.rows[0].id, from: fromName, to: toName, dist: estDist, manual: true,
                    from_lat: from.waypoint.latitude, from_lon: from.waypoint.longitude,
                    to_lat: to.waypoint.latitude, to_lon: to.waypoint.longitude
                });
                manualSegments.push({ from: fromName, to: toName, dist: estDist });
            }

            // Create parking/stop record at destination waypoint (except the last segment's end)
            if (to.hasGps && i < wpData.length - 2) {
                // Find stop duration at this waypoint
                const nextFrom = wpData[i + 2];
                let stopEnd;
                if (nextFrom?.hasGps) {
                    // Stop until next segment starts (next GPS time minus some buffer)
                    stopEnd = nextFrom.gpsTime;
                } else {
                    // Estimate 5 min stop
                    stopEnd = new Date(to.gpsTime.getTime() + 5 * 60000);
                }

                const stopDur = Math.round((stopEnd - to.gpsTime) / 1000);
                if (stopDur >= 300 && stopDur < 7200) { // min 5 min, max 2 hours
                    await client.query(
                        `INSERT INTO trips (
                            vehicle_id, start_time, end_time,
                            start_latitude, start_longitude, end_latitude, end_longitude,
                            start_address, end_address,
                            distance_meters, duration_seconds,
                            trip_type, status, is_parking, internal_notes
                        ) VALUES ($1,$2,$3,$4,$5,$4,$5,$6,$6,0,$7,'unconfirmed','UNCONFIRMED',true,$8)`,
                        [
                            vehicleId, to.gpsTime, stopEnd,
                            to.waypoint.latitude, to.waypoint.longitude,
                            toName, stopDur,
                            'Zastavenie: ' + toName
                        ]
                    );
                    createdStops.push({ name: toName, duration: stopDur });
                }
            }
        }

        // 5. Hide existing overlapping trips for this date
        if (createdTrips.length > 0) {
            const firstNewId = createdTrips[0].id;
            await client.query(
                `UPDATE trips SET merged_into_id = $1,
                     internal_notes = COALESCE(internal_notes, '') || ' | Nahradená waypoint trasou'
                 WHERE start_time::date = $2
                   AND merged_into_id IS NULL
                   AND id != $1
                   AND id NOT IN (SELECT unnest($3::int[]))
                   AND is_parking = false`,
                [firstNewId, date, createdTrips.map(t => t.id)]
            );
            // Also hide old parking
            await client.query(
                `UPDATE trips SET merged_into_id = $1
                 WHERE start_time::date = $2
                   AND merged_into_id IS NULL
                   AND is_parking = true
                   AND id NOT IN (SELECT unnest($3::int[]))`,
                [firstNewId, date, []] // hide all old parking
            );
        }

        // 6. Auto-save waypoints
        for (const wp of waypoints) {
            try {
                await client.query(
                    `INSERT INTO saved_places (google_place_id, name, address, latitude, longitude, place_type)
                     VALUES ($1, $2, $3, $4, $5, $6)
                     ON CONFLICT (google_place_id) DO UPDATE SET
                        use_count = saved_places.use_count + 1,
                        last_used_at = NOW()`,
                    [wp.id || ('manual_' + wp.latitude + '_' + wp.longitude), wp.name, wp.address || null, wp.latitude, wp.longitude, wp.type || null]
                );
            } catch (e) { /* ignore dups */ }
        }

        await client.query('COMMIT');

        // Prepočítať odometer po vytvorení nových jázd
        db.query('SELECT recalculate_odometers()').catch(() => {});

        const msg = `Vytvorené: ${createdTrips.length} jázd, ${createdStops.length} zastavení` +
            (manualSegments.length > 0 ? ` (${manualSegments.length} bez GPS)` : '');

        res.json({
            message: msg,
            segments: createdTrips.length,
            stops: createdStops.length,
            manual_segments: manualSegments,
            details: createdTrips.map(t => ({
                id: t.id,
                from: t.from,
                to: t.to,
                distance_m: t.dist,
                manual: t.manual,
                from_lat: t.from_lat,
                from_lon: t.from_lon,
                to_lat: t.to_lat,
                to_lon: t.to_lon
            }))
        });
    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Split by waypoints error:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;
