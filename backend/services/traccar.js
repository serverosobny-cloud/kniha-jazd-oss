const axios = require('axios');
const db = require('../db');

function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = d => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

class TraccarService {
    constructor() {
        this.baseUrl = process.env.TRACCAR_URL || 'http://traccar:8082/api';
        this.email = process.env.TRACCAR_EMAIL;
        this.password = process.env.TRACCAR_PASSWORD;
        this.sessionCookie = null;
    }

    async authenticate() {
        try {
            const params = new URLSearchParams();
            params.append('email', this.email);
            params.append('password', this.password);

            const response = await axios.post(`${this.baseUrl}/session`, params, {
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
            });

            this.sessionCookie = response.headers['set-cookie'];
            return true;
        } catch (error) {
            console.error('Traccar autentifikácia zlyhala:', error.message);
            throw new Error('Nepodarilo sa pripojiť k Traccar');
        }
    }

    async makeRequest(endpoint, params = {}) {
        if (!this.sessionCookie) {
            await this.authenticate();
        }

        try {
            const response = await axios.get(`${this.baseUrl}${endpoint}`, {
                params,
                headers: {
                    Cookie: this.sessionCookie
                }
            });
            return response.data;
        } catch (error) {
            if (error.response?.status === 401) {
                // Session expired, try re-authenticating
                await this.authenticate();
                return this.makeRequest(endpoint, params);
            }
            throw error;
        }
    }

    async getDevices() {
        return this.makeRequest('/devices');
    }

    async getPositions(deviceId, from, to) {
        return this.makeRequest('/positions', {
            deviceId,
            from: from.toISOString(),
            to: to.toISOString()
        });
    }

    async importRecentPositions(hoursBack = 1) {
        const client = await db.getClient();
        
        try {
            await client.query('BEGIN');

            const logResult = await client.query(
                `INSERT INTO import_log (import_type, started_at, status, records_processed, records_inserted, records_updated, errors)
                 VALUES ($1, $2, $3, 0, 0, 0, 0) RETURNING id`,
                ['positions', new Date(), 'running']
            );
            const logId = logResult.rows[0].id;

            let totalProcessed = 0;
            let totalInserted = 0;
            let totalUpdated = 0;
            let totalErrors = 0;
            const errors = [];

            // Get all vehicle-device mappings (vehicle_devices table has multi-device support)
            const vehiclesResult = await client.query(
                `SELECT DISTINCT vd.vehicle_id as id, vd.traccar_device_id
                 FROM vehicle_devices vd
                 UNION
                 SELECT v.id, v.traccar_device_id FROM vehicles v WHERE v.traccar_device_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM vehicle_devices vd2 WHERE vd2.vehicle_id = v.id AND vd2.traccar_device_id = v.traccar_device_id)`
            );

            const to = new Date();
            const from = new Date(to.getTime() - hoursBack * 60 * 60 * 1000);

            for (const vehicle of vehiclesResult.rows) {
                try {
                    const positions = await this.getPositions(vehicle.traccar_device_id, from, to);
                    
                    for (const pos of positions) {
                        totalProcessed++;
                        
                        try {
                            const result = await client.query(
                                `INSERT INTO positions (
                                    traccar_id, device_id, vehicle_id, latitude, longitude,
                                    altitude, speed, course, address, accuracy,
                                    device_time, server_time, fix_time, attributes
                                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
                                ON CONFLICT (traccar_id) DO UPDATE SET
                                    latitude = EXCLUDED.latitude,
                                    longitude = EXCLUDED.longitude,
                                    altitude = EXCLUDED.altitude,
                                    speed = EXCLUDED.speed,
                                    course = EXCLUDED.course,
                                    address = EXCLUDED.address,
                                    accuracy = EXCLUDED.accuracy,
                                    attributes = EXCLUDED.attributes
                                RETURNING (xmax = 0) AS inserted`,
                                [
                                    pos.id,
                                    pos.deviceId,
                                    vehicle.id,
                                    pos.latitude,
                                    pos.longitude,
                                    pos.altitude,
                                    pos.speed,
                                    pos.course,
                                    pos.address,
                                    pos.accuracy,
                                    pos.deviceTime,
                                    pos.serverTime,
                                    pos.fixTime,
                                    JSON.stringify(pos.attributes || {})
                                ]
                            );

                            if (result.rows[0].inserted) {
                                totalInserted++;
                            } else {
                                totalUpdated++;
                            }
                        } catch (err) {
                            totalErrors++;
                            errors.push(`Position ${pos.id}: ${err.message}`);
                        }
                    }
                } catch (err) {
                    totalErrors++;
                    errors.push(`Vehicle ${vehicle.id}: ${err.message}`);
                }
            }

            await client.query(
                `UPDATE import_log 
                 SET completed_at = $1, status = $2, records_processed = $3,
                     records_inserted = $4, records_updated = $5, errors = $6,
                     error_messages = $7
                 WHERE id = $8`,
                [
                    new Date(),
                    totalErrors > 0 ? 'completed_with_errors' : 'completed',
                    totalProcessed,
                    totalInserted,
                    totalUpdated,
                    totalErrors,
                    errors.join('\n'),
                    logId
                ]
            );

            await client.query('COMMIT');

            return {
                processed: totalProcessed,
                inserted: totalInserted,
                updated: totalUpdated,
                errors: totalErrors
            };

        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Get trips from Traccar reports API
     */
    async getTrips(deviceId, from, to) {
        return this.makeRequest('/reports/trips', {
            deviceId,
            from: from.toISOString(),
            to: to.toISOString()
        });
    }

    /**
     * Import trips from Traccar for a specific vehicle
     * Fetches from all devices assigned to the vehicle via vehicle_devices table
     */
    async importTrips(vehicleId, from, to) {
        const client = await db.getClient();
        let totalProcessed = 0;
        let totalInserted = 0;
        let totalSkipped = 0;
        let totalMerged = 0;
        let totalErrors = 0;
        const errors = [];

        try {
            await client.query('BEGIN');

            // Get all Traccar devices for this vehicle
            const devicesResult = await client.query(
                'SELECT traccar_device_id FROM vehicle_devices WHERE vehicle_id = $1',
                [vehicleId]
            );
            let deviceIds = devicesResult.rows.map(r => r.traccar_device_id);
            if (deviceIds.length === 0) {
                const vehicleResult = await client.query(
                    'SELECT traccar_device_id FROM vehicles WHERE id = $1 AND traccar_device_id IS NOT NULL',
                    [vehicleId]
                );
                deviceIds = vehicleResult.rows.map(r => r.traccar_device_id);
            }

            // Step 1: Collect trips from ALL devices
            const allRawTrips = [];
            for (const deviceId of deviceIds) {
                try {
                    const trips = await this.getTrips(deviceId, from, to);
                    for (const trip of trips) {
                        allRawTrips.push({ ...trip, _deviceId: deviceId });
                    }
                } catch (err) {
                    totalErrors++;
                    errors.push(`Device ${deviceId}: ${err.message}`);
                }
            }

            // Step 2: Import ALL trips (no pre-filtering)
            const TIME_WINDOW_MS = 2 * 60 * 1000; // 2 min

            for (const trip of allRawTrips) {
                totalProcessed++;

                try {
                    const distanceM = trip.distance || 0;
                    const durationMs = trip.duration || 0;
                    const durationH = durationMs / (1000 * 3600);
                    const avgSpeedKmh = durationH > 0 ? (distanceM / 1000) / durationH : 0;
                    const isParking = distanceM < 500 && avgSpeedKmh < 5;
                    const startPosId = trip.startPositionId || null;
                    const endPosId = trip.endPositionId || null;
                    const durationSeconds = trip.duration ? Math.round(trip.duration / 1000) : null;

                    // Exact idempotency: same position IDs = same Traccar trip
                    if (startPosId && endPosId) {
                        const exactDup = await client.query(
                            `SELECT id FROM trips
                             WHERE traccar_position_id_start = $1
                               AND traccar_position_id_end = $2`,
                            [startPosId, endPosId]
                        );
                        if (exactDup.rows.length > 0) {
                            totalSkipped++;
                            continue;
                        }
                    }

                    // Geofence zones
                    let startZoneId = null;
                    let endZoneId = null;
                    try {
                        const r = await client.query('SELECT find_geofence_zone($1, $2) as zone_id', [trip.startLat, trip.startLon]);
                        startZoneId = r.rows[0]?.zone_id || null;
                    } catch (e) { /* ignore */ }
                    try {
                        const r = await client.query('SELECT find_geofence_zone($1, $2) as zone_id', [trip.endLat, trip.endLon]);
                        endZoneId = r.rows[0]?.zone_id || null;
                    } catch (e) { /* ignore */ }

                    // Auto-classification
                    let tripType = 'unconfirmed';
                    let tripPurpose = null;
                    if (startZoneId || endZoneId) {
                        try {
                            const s = await client.query('SELECT * FROM suggest_trip_classification($1, $2)', [startZoneId, endZoneId]);
                            if (s.rows[0]?.suggested_type) {
                                tripType = s.rows[0].suggested_type;
                                tripPurpose = s.rows[0].suggested_purpose || null;
                            }
                        } catch (e) { /* ignore */ }
                    }

                    // Insert the trip
                    const insertResult = await client.query(
                        `INSERT INTO trips (
                            vehicle_id, start_time, end_time,
                            start_latitude, start_longitude, end_latitude, end_longitude,
                            start_address, end_address,
                            distance_meters, duration_seconds,
                            traccar_position_id_start, traccar_position_id_end,
                            start_zone_id, end_zone_id,
                            trip_type, trip_purpose, status, is_parking
                        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'UNCONFIRMED',$18)
                        RETURNING id`,
                        [
                            vehicleId, trip.startTime, trip.endTime,
                            trip.startLat, trip.startLon, trip.endLat, trip.endLon,
                            trip.startAddress || null, trip.endAddress || null,
                            distanceM, durationSeconds,
                            startPosId, endPosId,
                            startZoneId, endZoneId,
                            tripType, tripPurpose, isParking
                        ]
                    );
                    const newId = insertResult.rows[0].id;
                    totalInserted++;

                    // Step 3: Merge check - find overlapping trips for same vehicle
                    // Two trips overlap if their time ranges intersect
                    // (trip A starts before trip B ends AND trip B starts before trip A ends)
                    const overlapping = await client.query(
                        `SELECT id, distance_meters FROM trips
                         WHERE vehicle_id = $1
                           AND merged_into_id IS NULL
                           AND id != $4
                           AND start_time < $3::timestamp + interval '2 minutes'
                           AND end_time > $2::timestamp - interval '2 minutes'
                         ORDER BY distance_meters DESC`,
                        [vehicleId, trip.startTime, trip.endTime, newId]
                    );

                    if (overlapping.rows.length > 0) {
                        // Compare: new trip vs best existing
                        const bestExisting = overlapping.rows[0];
                        if (distanceM >= parseFloat(bestExisting.distance_meters)) {
                            // New trip is longer/equal - it wins, mark existing as merged
                            for (const row of overlapping.rows) {
                                await client.query(
                                    'UPDATE trips SET merged_into_id = $1 WHERE id = $2 AND merged_into_id IS NULL',
                                    [newId, row.id]
                                );
                                totalMerged++;
                            }
                        } else {
                            // Existing trip is longer - mark new trip as merged
                            await client.query(
                                'UPDATE trips SET merged_into_id = $1 WHERE id = $2',
                                [bestExisting.id, newId]
                            );
                            totalMerged++;
                        }
                    }

                    // Step 4: Split long trips at stops
                    if (!isParking && durationMs > 600000 && distanceM > 2000) {
                        try {
                            await this.splitTripAtStops(newId, vehicleId, trip._deviceId, trip.startTime, trip.endTime, trip, client);
                        } catch (splitErr) {
                            console.error(`Split failed for trip ${newId}:`, splitErr.message);
                        }
                    }
                } catch (err) {
                    if (err.code === '23505') {
                        totalSkipped++;
                    } else {
                        totalErrors++;
                        errors.push(`Trip device ${trip._deviceId}: ${err.message}`);
                    }
                }
            }

            await client.query('COMMIT');
            return { processed: totalProcessed, inserted: totalInserted, skipped: totalSkipped, merged: totalMerged, errors: totalErrors, errorMessages: errors };
        } catch (error) {
            await client.query('ROLLBACK');
            throw error;
        } finally {
            client.release();
        }
    }

    /**
     * Import trips for all vehicles with assigned Traccar devices
     */
    async importAllTrips(from, to) {
        const client = await db.getClient();

        try {
            // Log the import
            const logResult = await client.query(
                `INSERT INTO import_log (import_type, started_at, status, records_processed, records_inserted, records_updated, errors)
                 VALUES ($1, $2, $3, 0, 0, 0, 0) RETURNING id`,
                ['traccar_trips', new Date(), 'running']
            );
            const logId = logResult.rows[0].id;
            client.release();

            // Get vehicles that have devices via vehicle_devices table (preferred)
            // If a vehicle has entries in vehicle_devices, use those exclusively
            // Fall back to vehicles.traccar_device_id only for vehicles NOT in vehicle_devices
            const vehiclesResult = await db.query(
                `SELECT DISTINCT v.id FROM vehicles v
                 JOIN vehicle_devices vd ON v.id = vd.vehicle_id
                 UNION
                 SELECT v.id FROM vehicles v
                 WHERE v.traccar_device_id IS NOT NULL
                   AND NOT EXISTS (SELECT 1 FROM vehicle_devices vd2 WHERE vd2.traccar_device_id = v.traccar_device_id)`
            );

            let totalProcessed = 0;
            let totalInserted = 0;
            let totalSkipped = 0;
            let totalErrors = 0;
            const allErrors = [];

            for (const vehicle of vehiclesResult.rows) {
                try {
                    const result = await this.importTrips(vehicle.id, from, to);
                    totalProcessed += result.processed;
                    totalInserted += result.inserted;
                    totalSkipped += result.skipped;
                    totalErrors += result.errors;
                    allErrors.push(...result.errorMessages);
                } catch (err) {
                    totalErrors++;
                    allErrors.push(`Vehicle ${vehicle.id}: ${err.message}`);
                }
            }

            // Update log
            await db.query(
                `UPDATE import_log
                 SET completed_at = $1, status = $2, records_processed = $3,
                     records_inserted = $4, records_updated = $5, errors = $6,
                     error_messages = $7
                 WHERE id = $8`,
                [
                    new Date(),
                    totalErrors > 0 ? 'completed_with_errors' : 'completed',
                    totalProcessed,
                    totalInserted,
                    totalSkipped,
                    totalErrors,
                    allErrors.join('\n'),
                    logId
                ]
            );

            return { processed: totalProcessed, inserted: totalInserted, skipped: totalSkipped, errors: totalErrors };
        } catch (error) {
            client.release();
            throw error;
        }
    }

    /**
     * Split a trip at significant stops detected from GPS positions.
     * Creates sub-trips and parking records, marks original as split.
     */
    async splitTripAtStops(tripId, vehicleId, deviceId, startTime, endTime, tripData, client) {
        const SPEED_THRESHOLD = 1.5; // knots (~2.8 km/h)
        const MIN_STOP_DURATION = 120; // seconds (2 min)

        // Try local DB positions first, fallback to Traccar API
        let positions;
        const localResult = await client.query(
            `SELECT traccar_id as id, device_id as "deviceId", device_time as "deviceTime",
                    latitude, longitude, speed, address
             FROM positions
             WHERE device_id = $1 AND device_time BETWEEN $2 AND $3
             ORDER BY device_time`,
            [deviceId, startTime, endTime]
        );

        if (localResult.rows.length >= 10) {
            positions = localResult.rows;
        } else {
            try {
                positions = await this.getPositions(deviceId, new Date(startTime), new Date(endTime));
            } catch (e) {
                console.error('Cannot get positions from Traccar:', e.message);
                return null;
            }
        }
        if (!positions || positions.length < 10) return null;

        positions.sort((a, b) => new Date(a.deviceTime) - new Date(b.deviceTime));

        // Find internal stops (not at trip start/end)
        const stops = [];
        let stopStartIdx = null;

        for (let i = 0; i < positions.length; i++) {
            if (positions[i].speed < SPEED_THRESHOLD) {
                if (stopStartIdx === null) stopStartIdx = i;
            } else {
                if (stopStartIdx !== null) {
                    const sTime = new Date(positions[stopStartIdx].deviceTime);
                    const eTime = new Date(positions[i - 1].deviceTime);
                    const duration = (eTime - sTime) / 1000;

                    // Only internal stops (skip first/last 3 positions)
                    if (duration >= MIN_STOP_DURATION && stopStartIdx > 3 && i < positions.length - 3) {
                        stops.push({
                            startIdx: stopStartIdx,
                            endIdx: i - 1,
                            resumeIdx: i,
                            startTime: sTime,
                            endTime: eTime,
                            duration,
                            lat: positions[stopStartIdx].latitude,
                            lon: positions[stopStartIdx].longitude,
                            address: positions[stopStartIdx].address || null
                        });
                    }
                    stopStartIdx = null;
                }
            }
        }

        if (stops.length === 0) return null;

        // Build driving segments between stops
        const segments = [];
        let segStartIdx = 0;

        for (const stop of stops) {
            segments.push({
                startIdx: segStartIdx,
                endIdx: stop.startIdx,
                startPos: positions[segStartIdx],
                endPos: positions[stop.startIdx]
            });
            segStartIdx = stop.resumeIdx;
        }
        // Last segment: from last stop to trip end
        segments.push({
            startIdx: segStartIdx,
            endIdx: positions.length - 1,
            startPos: positions[segStartIdx],
            endPos: positions[positions.length - 1]
        });

        // Calculate distance for each segment
        for (const seg of segments) {
            let dist = 0;
            for (let i = seg.startIdx + 1; i <= seg.endIdx; i++) {
                dist += haversine(
                    positions[i - 1].latitude, positions[i - 1].longitude,
                    positions[i].latitude, positions[i].longitude
                );
            }
            seg.distance = dist;
        }

        // Filter: keep only segments with > 200m
        const validSegments = segments.filter(s => s.distance >= 200);
        if (validSegments.length <= 1) return null; // No meaningful split

        console.log(`Splitting trip ${tripId}: ${validSegments.length} segments, ${stops.length} stops`);

        // Create sub-trips for each segment
        const subTripIds = [];
        for (let i = 0; i < validSegments.length; i++) {
            const seg = validSegments[i];
            const isFirst = i === 0;
            const isLast = i === validSegments.length - 1;

            const sAddr = isFirst ? (tripData.startAddress || null) : (seg.startPos.address || null);
            const eAddr = isLast ? (tripData.endAddress || null) : (seg.endPos.address || null);

            const segStart = new Date(seg.startPos.deviceTime);
            const segEnd = new Date(seg.endPos.deviceTime);
            const durSec = Math.round((segEnd - segStart) / 1000);

            // Geofence zones
            let startZoneId = null, endZoneId = null;
            try {
                const r = await client.query('SELECT find_geofence_zone($1, $2) as zone_id', [seg.startPos.latitude, seg.startPos.longitude]);
                startZoneId = r.rows[0]?.zone_id || null;
            } catch (e) { /* ignore */ }
            try {
                const r = await client.query('SELECT find_geofence_zone($1, $2) as zone_id', [seg.endPos.latitude, seg.endPos.longitude]);
                endZoneId = r.rows[0]?.zone_id || null;
            } catch (e) { /* ignore */ }

            // Auto-classification
            let tripType = 'unconfirmed';
            let tripPurpose = null;
            if (startZoneId || endZoneId) {
                try {
                    const s = await client.query('SELECT * FROM suggest_trip_classification($1, $2)', [startZoneId, endZoneId]);
                    if (s.rows[0]?.suggested_type) {
                        tripType = s.rows[0].suggested_type;
                        tripPurpose = s.rows[0].suggested_purpose || null;
                    }
                } catch (e) { /* ignore */ }
            }

            const result = await client.query(
                `INSERT INTO trips (
                    vehicle_id, start_time, end_time,
                    start_latitude, start_longitude, end_latitude, end_longitude,
                    start_address, end_address,
                    distance_meters, duration_seconds,
                    start_zone_id, end_zone_id,
                    trip_type, trip_purpose, status, split_from_id,
                    internal_notes
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'UNCONFIRMED',$16,$17)
                RETURNING id`,
                [
                    vehicleId, segStart, segEnd,
                    seg.startPos.latitude, seg.startPos.longitude,
                    seg.endPos.latitude, seg.endPos.longitude,
                    sAddr, eAddr,
                    Math.round(seg.distance), durSec,
                    startZoneId, endZoneId,
                    tripType, tripPurpose, tripId,
                    'Automaticky rozdelený segment'
                ]
            );
            subTripIds.push(result.rows[0].id);
        }

        // Create parking records for stops
        for (const stop of stops) {
            await client.query(
                `INSERT INTO trips (
                    vehicle_id, start_time, end_time,
                    start_latitude, start_longitude, end_latitude, end_longitude,
                    start_address, end_address,
                    distance_meters, duration_seconds,
                    trip_type, status, is_parking, split_from_id,
                    internal_notes
                ) VALUES ($1,$2,$3,$4,$5,$4,$5,$6,$6,0,$7,'unconfirmed','UNCONFIRMED',true,$8,$9)
                RETURNING id`,
                [
                    vehicleId, stop.startTime, stop.endTime,
                    stop.lat, stop.lon,
                    stop.address || null,
                    Math.round(stop.duration), tripId,
                    'Zastavenie (automaticky detekované)'
                ]
            );
        }

        // Mark original trip as split (hide it using merged_into_id)
        await client.query(
            `UPDATE trips SET merged_into_id = $1,
             internal_notes = COALESCE(internal_notes, '') || 'Rozdelená na ' || $2 || ' segmentov'
             WHERE id = $3`,
            [subTripIds[0], validSegments.length.toString(), tripId]
        );

        return { segments: subTripIds.length, stops: stops.length, subTripIds };
    }

    async syncDevices() {
        const devices = await this.getDevices();

        // Only return the list of Traccar devices - do NOT auto-create vehicles
        // Vehicles should be managed manually, devices are assigned via vehicle_devices table
        return { synced: devices.length, devices };
    }
}

module.exports = new TraccarService();
