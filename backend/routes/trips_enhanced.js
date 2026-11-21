const express = require('express');
const router = express.Router();
const db = require('../db');
const https = require('https');

// ============================================================================
// HELPER FUNKCIE
// ============================================================================

/**
 * Nastaví current_user_id pre audit log
 */
function setCurrentUser(userId) {
    return db.query('SELECT set_config($1, $2, TRUE)', [
        'app.current_user_id',
        userId ? userId.toString() : '0'
    ]);
}

/**
 * Automaticky nájde geofence zónu pre súradnice
 */
async function findGeofenceZone(lat, lon) {
    const result = await db.query(
        'SELECT find_geofence_zone($1, $2) as zone_id',
        [lat, lon]
    );
    return result.rows[0]?.zone_id || null;
}

/**
 * Získa návrh klasifikácie
 */
async function suggestClassification(startZoneId, endZoneId) {
    const result = await db.query(
        'SELECT * FROM suggest_trip_classification($1, $2)',
        [startZoneId, endZoneId]
    );
    return result.rows[0] || null;
}

/**
 * Zavolá Google Routes API na výpočet vzdialenosti
 */
function callRoutesApi(apiKey, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req = https.request('https://routes.googleapis.com/directions/v2:computeRoutes', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Goog-Api-Key': apiKey,
                'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration',
                ...(process.env.PUBLIC_URL ? { 'Referer': process.env.PUBLIC_URL } : {})
            }
        }, (res) => {
            let responseData = '';
            res.on('data', chunk => responseData += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(responseData);
                    if (res.statusCode !== 200) {
                        reject(new Error(parsed.error?.message || `HTTP ${res.statusCode}`));
                    } else {
                        resolve(parsed);
                    }
                } catch (e) {
                    reject(new Error(`Parse error: ${responseData.substring(0, 200)}`));
                }
            });
        });
        req.on('error', reject);
        req.write(data);
        req.end();
    });
}

// ============================================================================
// CRUD OPERÁCIE S ROZŠÍRENÝM WORKFLOW
// ============================================================================

/**
 * GET /api/trips - Získať jazdy s filtrom
 * Podporuje pokročilé filtrovanie vrátane statusu a typu
 */
router.get('/', async (req, res) => {
    try {
        const {
            vehicle_id,
            driver_id,
            from,
            to,
            trip_type,
            status,
            period_locked,
            start_zone_id,
            end_zone_id,
            hide_parking,
            limit = 100,
            offset = 0
        } = req.query;

        let query = 'SELECT * FROM trips_detailed_view WHERE merged_into_id IS NULL';
        const params = [];
        let paramIndex = 1;

        if (vehicle_id) {
            params.push(vehicle_id);
            query += ` AND vehicle_id = $${paramIndex++}`;
        }

        if (driver_id) {
            params.push(driver_id);
            query += ` AND driver_id = $${paramIndex++}`;
        }

        if (from) {
            params.push(from);
            query += ` AND start_time >= $${paramIndex++}::date`;
        }

        if (to) {
            params.push(to);
            query += ` AND start_time < ($${paramIndex++}::date + interval '1 day')`;
        }

        if (trip_type) {
            params.push(trip_type);
            query += ` AND trip_type = $${paramIndex++}`;
        }

        if (status) {
            params.push(status);
            query += ` AND status = $${paramIndex++}`;
        }

        if (period_locked !== undefined) {
            params.push(period_locked === 'true');
            query += ` AND period_locked = $${paramIndex++}`;
        }

        if (start_zone_id) {
            params.push(start_zone_id);
            query += ` AND start_zone_id = $${paramIndex++}`;
        }

        if (end_zone_id) {
            params.push(end_zone_id);
            query += ` AND end_zone_id = $${paramIndex++}`;
        }

        if (hide_parking === 'true') {
            query += ` AND (is_parking = false OR is_parking IS NULL)`;
        }

        params.push(limit);
        query += ` ORDER BY start_time ASC LIMIT $${paramIndex++}`;

        params.push(offset);
        query += ` OFFSET $${paramIndex++}`;

        const result = await db.query(query, params);

        // Získať total count
        let countQuery = 'SELECT COUNT(*) FROM trips WHERE merged_into_id IS NULL';
        const countParams = [];
        let countIndex = 1;

        if (vehicle_id) {
            countParams.push(vehicle_id);
            countQuery += ` AND vehicle_id = $${countIndex++}`;
        }
        if (driver_id) {
            countParams.push(driver_id);
            countQuery += ` AND driver_id = $${countIndex++}`;
        }
        if (from) {
            countParams.push(from);
            countQuery += ` AND start_time >= $${countIndex++}::date`;
        }
        if (to) {
            countParams.push(to);
            countQuery += ` AND start_time < ($${countIndex++}::date + interval '1 day')`;
        }
        if (trip_type) {
            countParams.push(trip_type);
            countQuery += ` AND trip_type = $${countIndex++}`;
        }
        if (status) {
            countParams.push(status);
            countQuery += ` AND status = $${countIndex++}`;
        }

        const countResult = await db.query(countQuery, countParams);

        res.json({
            trips: result.rows,
            total: parseInt(countResult.rows[0].count),
            limit: parseInt(limit),
            offset: parseInt(offset)
        });
    } catch (err) {
        console.error('Chyba pri načítaní jázd:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/trips/unconfirmed - Získať nepotvrdené jazdy
 */
router.get('/unconfirmed', async (req, res) => {
    try {
        const { vehicle_id, driver_id } = req.query;

        let query = `
            SELECT * FROM trips_detailed_view
            WHERE status = 'UNCONFIRMED' AND merged_into_id IS NULL
        `;
        const params = [];
        let paramIndex = 1;

        if (vehicle_id) {
            params.push(vehicle_id);
            query += ` AND vehicle_id = $${paramIndex++}`;
        }

        if (driver_id) {
            params.push(driver_id);
            query += ` AND driver_id = $${paramIndex++}`;
        }

        query += ' ORDER BY start_time DESC';

        const result = await db.query(query, params);
        res.json({
            trips: result.rows,
            count: result.rows.length
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/trips/purpose-templates - Bežné účely jázd
 */
router.get('/purpose-templates', async (req, res) => {
    res.json([
        { id: 'client-meeting', label: 'Stretnutie s klientom', category: 'business' },
        { id: 'client-visit', label: 'Návšteva klienta', category: 'business' },
        { id: 'material-purchase', label: 'Nákup materiálu', category: 'business' },
        { id: 'company-purchase', label: 'Firemné nákupy', category: 'business' },
        { id: 'delivery', label: 'Dovoz/odvoz tovaru', category: 'business' },
        { id: 'vehicle-service', label: 'Servis vozidla', category: 'business' },
        { id: 'office-visit', label: 'Návšteva kancelárie/pobočky', category: 'business' },
        { id: 'bank-errand', label: 'Banka / úrad', category: 'business' },
        { id: 'tax-office', label: 'Daňový úrad / poisťovňa', category: 'business' },
        { id: 'post-office', label: 'Pošta / kuriér', category: 'business' },
        { id: 'training', label: 'Školenie / konferencia', category: 'business' },
        { id: 'site-inspection', label: 'Obhliadka / kontrola', category: 'business' },
        { id: 'business-trip', label: 'Pracovná cesta', category: 'business' },
        { id: 'medical-company', label: 'Lekárska prehliadka (firemná)', category: 'business' },
        { id: 'legal-errand', label: 'Právne záležitosti / notár', category: 'business' },
        { id: 'warehouse', label: 'Cesta na sklad / výdajné miesto', category: 'business' },
        { id: 'contract-signing', label: 'Podpis zmluvy', category: 'business' },
        { id: 'it-service', label: 'IT servis / inštalácia', category: 'business' },
        { id: 'marketing', label: 'Marketing / propagácia', category: 'business' }
    ]);
});

/**
 * POST /api/trips/recalculate-distances - Prepočítať vzdialenosti cez Google Routes API
 * Použije GPS pozície ako medzibody pre presnejší výpočet
 */
router.post('/recalculate-distances', async (req, res) => {
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (!apiKey) {
        return res.status(500).json({ error: 'Google API key nie je nakonfigurovaný' });
    }

    try {
        const { trip_ids } = req.body;

        // Získať jazdy na prepočítanie
        let tripsResult;
        if (trip_ids && trip_ids.length > 0) {
            tripsResult = await db.query(
                `SELECT id, vehicle_id, start_time, end_time,
                        start_latitude, start_longitude, end_latitude, end_longitude,
                        distance_meters
                 FROM trips
                 WHERE id = ANY($1::int[])
                   AND start_latitude IS NOT NULL AND end_latitude IS NOT NULL`,
                [trip_ids]
            );
        } else {
            tripsResult = await db.query(
                `SELECT id, vehicle_id, start_time, end_time,
                        start_latitude, start_longitude, end_latitude, end_longitude,
                        distance_meters
                 FROM trips
                 WHERE start_latitude IS NOT NULL AND end_latitude IS NOT NULL
                   AND distance_meters > 100
                   AND merged_into_id IS NULL
                 ORDER BY start_time ASC`
            );
        }

        const results = [];
        let apiCalls = 0;

        for (const trip of tripsResult.rows) {
            // Získať GPS pozície pre túto jazdu
            const posResult = await db.query(
                `SELECT latitude, longitude FROM positions
                 WHERE vehicle_id = $1 AND device_time BETWEEN $2 AND $3
                 ORDER BY device_time ASC`,
                [trip.vehicle_id, trip.start_time, trip.end_time]
            );

            const positions = posResult.rows;
            let intermediates = [];

            if (positions.length > 2) {
                // Každý N-tý bod, max 20 medzibodov
                const maxWaypoints = 20;
                const step = Math.max(5, Math.ceil(positions.length / maxWaypoints));

                for (let i = step; i < positions.length - 1; i += step) {
                    intermediates.push({
                        location: {
                            latLng: {
                                latitude: parseFloat(positions[i].latitude),
                                longitude: parseFloat(positions[i].longitude)
                            }
                        }
                    });
                    if (intermediates.length >= maxWaypoints) break;
                }
            }

            // Zostrojiť request body
            const body = {
                origin: {
                    location: {
                        latLng: {
                            latitude: parseFloat(trip.start_latitude),
                            longitude: parseFloat(trip.start_longitude)
                        }
                    }
                },
                destination: {
                    location: {
                        latLng: {
                            latitude: parseFloat(trip.end_latitude),
                            longitude: parseFloat(trip.end_longitude)
                        }
                    }
                },
                travelMode: 'DRIVE',
                routingPreference: 'TRAFFIC_UNAWARE'
            };

            if (intermediates.length > 0) {
                body.intermediates = intermediates;
            }

            try {
                const routeResponse = await callRoutesApi(apiKey, body);
                apiCalls++;

                if (routeResponse?.routes?.[0]?.distanceMeters) {
                    const newDistance = routeResponse.routes[0].distanceMeters;
                    const duration = routeResponse.routes[0].duration;
                    const durationSec = duration ? parseInt(duration.replace('s', '')) : null;

                    await db.query(
                        'UPDATE trips SET distance_meters = $1 WHERE id = $2',
                        [newDistance, trip.id]
                    );

                    results.push({
                        id: trip.id,
                        old_km: (parseFloat(trip.distance_meters) / 1000).toFixed(1),
                        new_km: (newDistance / 1000).toFixed(1),
                        waypoints: intermediates.length,
                        positions: positions.length
                    });
                }
            } catch (e) {
                results.push({
                    id: trip.id,
                    error: e.message
                });
            }

            // Rate limiting - 100ms medzi requestmi
            if (apiCalls < tripsResult.rows.length) {
                await new Promise(r => setTimeout(r, 100));
            }
        }

        const ok = results.filter(r => !r.error);
        const errors = results.filter(r => r.error);

        // Prepočítať odometer po zmene vzdialeností
        if (ok.length > 0) {
            await db.query('SELECT recalculate_odometers()');
        }

        res.json({
            recalculated: ok.length,
            errors: errors.length,
            api_calls: apiCalls,
            total: tripsResult.rows.length,
            details: results
        });

    } catch (err) {
        console.error('Chyba pri prepočítaní vzdialeností:', err);
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/trips/recalculate-odometers - Prepočítať stav tachometra
 */
router.post('/recalculate-odometers', async (req, res) => {
    try {
        const { vehicle_id } = req.body;
        const result = await db.query(
            'SELECT recalculate_odometers($1) as updated',
            [vehicle_id || null]
        );
        res.json({ updated: result.rows[0].updated });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/trips/:id/positions - GPS pozície pre jazdu
 */
router.get('/:id/positions', async (req, res) => {
    try {
        const tripResult = await db.query(
            'SELECT vehicle_id, start_time, end_time FROM trips WHERE id = $1',
            [req.params.id]
        );
        if (tripResult.rows.length === 0) {
            return res.status(404).json({ error: 'Jazda nenájdená' });
        }
        const trip = tripResult.rows[0];

        const { step = 1 } = req.query;

        const result = await db.query(
            `SELECT latitude, longitude, speed, device_time, address
             FROM (
                 SELECT *, ROW_NUMBER() OVER (ORDER BY device_time ASC) as rn
                 FROM positions
                 WHERE vehicle_id = $1 AND device_time BETWEEN $2 AND $3
             ) sub
             WHERE sub.rn % $4 = 1 OR sub.rn = 1
             ORDER BY device_time ASC`,
            [trip.vehicle_id, trip.start_time, trip.end_time, parseInt(step)]
        );

        res.json({
            trip_id: parseInt(req.params.id),
            count: result.rows.length,
            positions: result.rows
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/trips/:id - Detail jazdy
 */
router.get('/:id', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM trips_detailed_view WHERE id = $1',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Jazda nenájdená' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/trips - Vytvoriť novú jazdu (manuálne)
 */
router.post('/', async (req, res) => {
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const {
            vehicle_id,
            driver_id,
            start_time,
            end_time,
            start_latitude,
            start_longitude,
            end_latitude,
            end_longitude,
            start_address,
            end_address,
            distance_meters,
            trip_type = 'unconfirmed',
            trip_purpose,
            created_by
        } = req.body;

        // Validácia povinných polí
        if (!vehicle_id || !start_time) {
            throw new Error('Povinné polia: vehicle_id, start_time');
        }

        // Vypočítať trvanie ak máme oba časy
        let durationSeconds = req.body.duration_seconds || null;
        if (!durationSeconds && start_time && end_time) {
            durationSeconds = Math.round((new Date(end_time) - new Date(start_time)) / 1000);
        }

        // Nájsť geofence zóny
        const startZoneId = await findGeofenceZone(start_latitude, start_longitude);
        const endZoneId = end_latitude && end_longitude ? 
            await findGeofenceZone(end_latitude, end_longitude) : null;

        // Nastaviť user context pre audit
        if (created_by) {
            await setCurrentUser(created_by);
        }

        // Vytvoriť jazdu
        const result = await client.query(
            `INSERT INTO trips (
                vehicle_id, driver_id,
                start_time, end_time,
                start_latitude, start_longitude,
                end_latitude, end_longitude,
                start_address, end_address,
                distance_meters, duration_seconds,
                start_zone_id, end_zone_id,
                trip_type, trip_purpose,
                status,
                created_by, last_modified_by,
                internal_notes
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $18, $19)
            RETURNING *`,
            [
                vehicle_id, driver_id,
                start_time, end_time,
                start_latitude, start_longitude,
                end_latitude, end_longitude,
                start_address, end_address,
                distance_meters || 0, durationSeconds,
                startZoneId, endZoneId,
                trip_type, trip_purpose,
                'UNCONFIRMED',
                created_by,
                req.body.internal_notes || null
            ]
        );

        await client.query('COMMIT');
        // Prepočítať odometer
        db.query('SELECT recalculate_odometers($1)', [vehicle_id]).catch(() => {});
        res.status(201).json(result.rows[0]);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Chyba pri vytváraní jazdy:', err);
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * PUT /api/trips/:id - Aktualizovať jazdu
 */
router.put('/:id', async (req, res) => {
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const {
            driver_id,
            trip_type,
            trip_purpose,
            start_address,
            end_address,
            distance_meters,
            internal_notes,
            modified_by
        } = req.body;

        // Validácia business trip
        if (trip_type === 'business' && (!trip_purpose || trip_purpose.trim().length < 3)) {
            throw new Error('Účel jazdy je povinný pre služobné jazdy');
        }

        // Overiť, či jazda existuje a nie je zamknutá
        const checkResult = await client.query(
            'SELECT period_locked, status FROM trips WHERE id = $1',
            [req.params.id]
        );

        if (checkResult.rows.length === 0) {
            throw new Error('Jazda nenájdená');
        }

        if (checkResult.rows[0].period_locked) {
            throw new Error('Jazda je zamknutá a nemôže byť upravená');
        }

        // Nastaviť user context
        if (modified_by) {
            await setCurrentUser(modified_by);
        }

        // For private trips, clear purpose
        const effectivePurpose = trip_type === 'private' ? null : trip_purpose;

        // Aktualizovať jazdu
        const result = await client.query(
            `UPDATE trips
             SET driver_id = COALESCE($1, driver_id),
                 trip_type = COALESCE($2, trip_type),
                 trip_purpose = CASE WHEN $2 = 'private' THEN NULL ELSE COALESCE($3, trip_purpose) END,
                 start_address = COALESCE($4, start_address),
                 end_address = COALESCE($5, end_address),
                 distance_meters = COALESCE($6, distance_meters),
                 internal_notes = COALESCE($7, internal_notes),
                 last_modified_by = $8,
                 last_modified_at = NOW()
             WHERE id = $9
             RETURNING *`,
            [
                driver_id, trip_type, effectivePurpose,
                start_address, end_address, distance_meters,
                internal_notes, modified_by, req.params.id
            ]
        );

        await client.query('COMMIT');
        res.json(result.rows[0]);

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Chyba pri aktualizácii jazdy:', err);
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * POST /api/trips/:id/confirm - Potvrdiť jazdu
 */
router.post('/:id/confirm', async (req, res) => {
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const { confirmed_by, trip_type, trip_purpose, driver_id } = req.body;

        // Overiť existenciu
        const checkResult = await client.query(
            'SELECT * FROM trips WHERE id = $1',
            [req.params.id]
        );

        if (checkResult.rows.length === 0) {
            throw new Error('Jazda nenájdená');
        }

        const trip = checkResult.rows[0];

        if (trip.period_locked) {
            throw new Error('Jazda je zamknutá');
        }

        if (trip.status === 'CONFIRMED' || trip.status === 'LOCKED') {
            throw new Error('Jazda je už potvrdená');
        }

        // Použiť dodané hodnoty alebo existujúce
        const finalTripType = trip_type || trip.trip_type;
        const finalTripPurpose = trip_purpose || trip.trip_purpose;
        const finalDriverId = driver_id || trip.driver_id;

        // Validácia business trip
        if (finalTripType === 'business' && (!finalTripPurpose || finalTripPurpose.trim().length < 3)) {
            throw new Error('Účel jazdy je povinný pre služobné jazdy');
        }

        // Validácia vodiča
        if (!finalDriverId) {
            throw new Error('Vodič musí byť priradený pred potvrdením');
        }

        // Nastaviť user context
        if (confirmed_by) {
            await setCurrentUser(confirmed_by);
        }

        // Potvrdiť jazdu
        const result = await client.query(
            `UPDATE trips 
             SET status = 'CONFIRMED',
                 trip_type = $1,
                 trip_purpose = $2,
                 driver_id = $3,
                 confirmed_at = NOW(),
                 confirmed_by = $4,
                 last_modified_by = $4
             WHERE id = $5
             RETURNING *`,
            [finalTripType, finalTripPurpose, finalDriverId, confirmed_by, req.params.id]
        );

        await client.query('COMMIT');
        res.json({
            message: 'Jazda potvrdená',
            trip: result.rows[0]
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Chyba pri potvrdení jazdy:', err);
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * POST /api/trips/:id/suggest-classification - Získať návrh klasifikácie
 */
router.post('/:id/suggest-classification', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT start_zone_id, end_zone_id FROM trips WHERE id = $1',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Jazda nenájdená' });
        }

        const { start_zone_id, end_zone_id } = result.rows[0];

        if (!start_zone_id && !end_zone_id) {
            return res.json({
                suggestion: null,
                message: 'Jazda nie je v žiadnej geofence zóne'
            });
        }

        const suggestion = await suggestClassification(start_zone_id, end_zone_id);

        res.json({
            suggestion,
            start_zone_id,
            end_zone_id
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/trips/:id/split - Rozdeliť jazdu na segmenty podľa zastavení
 */
router.post('/:id/split', async (req, res) => {
    const client = await db.getClient();
    try {
        await client.query('BEGIN');

        // Get trip details
        const tripResult = await client.query(
            'SELECT * FROM trips WHERE id = $1', [req.params.id]
        );
        if (tripResult.rows.length === 0) {
            throw new Error('Jazda nenájdená');
        }
        const trip = tripResult.rows[0];
        if (trip.merged_into_id || trip.split_from_id) {
            throw new Error('Jazda je už rozdelená alebo zlúčená');
        }

        // Find device ID from positions or vehicle_devices
        let deviceId = null;
        if (trip.traccar_position_id_start) {
            const posResult = await client.query(
                'SELECT device_id FROM positions WHERE traccar_id = $1',
                [trip.traccar_position_id_start]
            );
            if (posResult.rows.length > 0) deviceId = posResult.rows[0].device_id;
        }
        if (!deviceId) {
            const devResult = await client.query(
                'SELECT traccar_device_id FROM vehicle_devices WHERE vehicle_id = $1 LIMIT 1',
                [trip.vehicle_id]
            );
            if (devResult.rows.length > 0) deviceId = devResult.rows[0].traccar_device_id;
        }
        if (!deviceId) throw new Error('Nenájdené Traccar zariadenie pre túto jazdu');

        const traccar = require('../services/traccar');
        const tripData = {
            startAddress: trip.start_address,
            endAddress: trip.end_address
        };

        const result = await traccar.splitTripAtStops(
            trip.id, trip.vehicle_id, deviceId,
            trip.start_time, trip.end_time, tripData, client
        );

        if (!result) {
            throw new Error('Žiadne významné zastavenia nenájdené (> 2 min)');
        }

        await client.query('COMMIT');
        res.json({
            message: `Jazda rozdelená na ${result.segments} segmentov s ${result.stops} zastaveniami`,
            ...result
        });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * GET /api/trips/:id/audit - Získať audit log pre jazdu
 */
router.get('/:id/audit', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT 
                tal.*,
                CONCAT(d.first_name, ' ', d.last_name) as changed_by_name
             FROM trip_audit_log tal
             LEFT JOIN drivers d ON tal.changed_by = d.id
             WHERE tal.trip_id = $1
             ORDER BY tal.changed_at DESC`,
            [req.params.id]
        );

        res.json({
            audit_log: result.rows,
            count: result.rows.length
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/trips/:id - Vymazať jazdu
 */
router.delete('/:id', async (req, res) => {
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const { deleted_by } = req.body;

        // Overiť, či nie je zamknutá
        const checkResult = await client.query(
            'SELECT period_locked FROM trips WHERE id = $1',
            [req.params.id]
        );

        if (checkResult.rows.length === 0) {
            throw new Error('Jazda nenájdená');
        }

        if (checkResult.rows[0].period_locked) {
            throw new Error('Nemôžete vymazať zamknutú jazdu');
        }

        // Nastaviť user context
        if (deleted_by) {
            await setCurrentUser(deleted_by);
        }

        // Vymazať jazdu (audit trigger sa automaticky spustí)
        const result = await client.query(
            'DELETE FROM trips WHERE id = $1 RETURNING *',
            [req.params.id]
        );

        await client.query('COMMIT');
        res.json({
            message: 'Jazda vymazaná',
            trip: result.rows[0]
        });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * POST /api/trips/bulk-confirm - Hromadné potvrdenie jázd
 */
router.post('/bulk-confirm', async (req, res) => {
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const { trip_ids, confirmed_by, driver_id, trip_type, trip_purpose } = req.body;

        if (!trip_ids || !Array.isArray(trip_ids) || trip_ids.length === 0) {
            throw new Error('trip_ids must be non-empty array');
        }

        // Nastaviť user context
        if (confirmed_by) {
            await setCurrentUser(confirmed_by);
        }

        // Pre-apply driver/type/purpose if provided (before validation)
        if (driver_id || trip_type || trip_purpose) {
            const setClauses = [];
            const setParams = [];
            let si = 1;
            if (driver_id) { setParams.push(driver_id); setClauses.push(`driver_id = $${si++}`); }
            if (trip_type) { setParams.push(trip_type); setClauses.push(`trip_type = $${si++}`); }
            if (trip_purpose) { setParams.push(trip_purpose); setClauses.push(`trip_purpose = $${si++}`); }
            setParams.push(trip_ids);
            await client.query(
                `UPDATE trips SET ${setClauses.join(', ')}, last_modified_at = NOW()
                 WHERE id = ANY($${si}::int[]) AND status != 'LOCKED'`,
                setParams
            );
        }

        // Overiť, že všetky jazdy sú validné pre potvrdenie
        const checkResult = await client.query(
            `SELECT id, status, period_locked, trip_type, trip_purpose, driver_id
             FROM trips
             WHERE id = ANY($1::int[])`,
            [trip_ids]
        );

        const errors = [];
        const validTripIds = [];

        for (const trip of checkResult.rows) {
            if (trip.period_locked) {
                errors.push(`Trip ${trip.id}: zamknutá`);
                continue;
            }
            if (trip.status !== 'UNCONFIRMED') {
                errors.push(`Trip ${trip.id}: už potvrdená`);
                continue;
            }
            if (trip.trip_type === 'business' && (!trip.trip_purpose || trip.trip_purpose.trim().length < 3)) {
                errors.push(`Trip ${trip.id}: chýba účel pre služobnú jazdu`);
                continue;
            }
            if (!trip.driver_id) {
                errors.push(`Trip ${trip.id}: chýba vodič`);
                continue;
            }

            validTripIds.push(trip.id);
        }

        // Potvrdiť validné jazdy
        let confirmedCount = 0;
        if (validTripIds.length > 0) {
            const result = await client.query(
                `UPDATE trips 
                 SET status = 'CONFIRMED',
                     confirmed_at = NOW(),
                     confirmed_by = $1,
                     last_modified_by = $1
                 WHERE id = ANY($2::int[])
                 RETURNING id`,
                [confirmed_by, validTripIds]
            );
            confirmedCount = result.rowCount;
        }

        await client.query('COMMIT');

        res.json({
            confirmed: confirmedCount,
            errors: errors,
            total_requested: trip_ids.length
        });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * POST /api/trips/bulk-update - Hromadná aktualizácia jázd (typ, účel, vodič)
 */
router.post('/bulk-update', async (req, res) => {
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const { trip_ids, trip_type, trip_purpose, driver_id } = req.body;

        if (!trip_ids || !Array.isArray(trip_ids) || trip_ids.length === 0) {
            throw new Error('trip_ids must be non-empty array');
        }

        const setClauses = [];
        const params = [];
        let paramIndex = 1;

        if (trip_type) {
            params.push(trip_type);
            setClauses.push(`trip_type = $${paramIndex++}`);
        }

        if (trip_purpose !== undefined) {
            params.push(trip_purpose || null);
            setClauses.push(`trip_purpose = $${paramIndex++}`);
        }

        if (driver_id !== undefined) {
            params.push(driver_id || null);
            setClauses.push(`driver_id = $${paramIndex++}`);
        }

        if (setClauses.length === 0) {
            throw new Error('Žiadne polia na aktualizáciu');
        }

        params.push(trip_ids);
        const result = await client.query(
            `UPDATE trips SET ${setClauses.join(', ')}, last_modified_at = NOW()
             WHERE id = ANY($${paramIndex}::int[])
               AND status != 'LOCKED'
             RETURNING id`,
            params
        );

        await client.query('COMMIT');

        res.json({
            updated: result.rowCount,
            total_requested: trip_ids.length
        });

    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

module.exports = router;
