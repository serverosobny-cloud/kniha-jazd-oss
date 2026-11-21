const express = require('express');
const router = express.Router();
const db = require('../db');
const PDFDocument = require('pdfkit');
const { Parser } = require('json2csv');

// ============================================================================
// UZAMYKANIE OBDOBÍ
// ============================================================================

/**
 * GET /api/periods/locks - Získať všetky uzamknutia
 */
router.get('/locks', async (req, res) => {
    try {
        const { vehicle_id } = req.query;

        let query = `
            SELECT 
                pl.*,
                v.name as vehicle_name,
                v.registration_plate,
                CONCAT(d.first_name, ' ', d.last_name) as locked_by_name
            FROM period_locks pl
            LEFT JOIN vehicles v ON pl.vehicle_id = v.id
            LEFT JOIN drivers d ON pl.locked_by = d.id
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (vehicle_id) {
            params.push(vehicle_id);
            query += ` AND pl.vehicle_id = $${paramIndex++}`;
        }

        query += ' ORDER BY pl.period_start DESC';

        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/periods/lock - Zamknúť obdobie
 */
router.post('/lock', async (req, res) => {
    try {
        const {
            vehicle_id,
            period_start,
            period_end,
            locked_by,
            lock_reason
        } = req.body;

        // Validácia
        if (!vehicle_id || !period_start || !period_end || !locked_by) {
            return res.status(400).json({
                error: 'Povinné polia: vehicle_id, period_start, period_end, locked_by'
            });
        }

        // Overiť dátumy
        if (new Date(period_end) < new Date(period_start)) {
            return res.status(400).json({
                error: 'Dátum konca musí byť po dátume začiatku'
            });
        }

        const result = await db.query(
            'SELECT lock_period($1, $2, $3, $4, $5) as lock_id',
            [vehicle_id, period_start, period_end, locked_by, lock_reason]
        );

        const lockId = result.rows[0].lock_id;

        // Získať detail zamknutia
        const lockResult = await db.query(
            'SELECT * FROM period_locks WHERE id = $1',
            [lockId]
        );

        res.status(201).json({
            message: 'Obdobie úspešne zamknuté',
            lock: lockResult.rows[0]
        });

    } catch (err) {
        console.error('Chyba pri zamykaní obdobia:', err);
        res.status(400).json({ error: err.message });
    }
});

/**
 * POST /api/periods/unlock - Odomknúť obdobie
 */
router.post('/unlock', async (req, res) => {
    const client = await db.getClient();

    try {
        await client.query('BEGIN');

        const { lock_id, unlocked_by, unlock_reason } = req.body;

        if (!lock_id || !unlocked_by) {
            throw new Error('Povinné polia: lock_id, unlocked_by');
        }

        // Získať detail zamknutia
        const lockResult = await client.query(
            'SELECT * FROM period_locks WHERE id = $1',
            [lock_id]
        );

        if (lockResult.rows.length === 0) {
            throw new Error('Zamknutie nenájdené');
        }

        const lock = lockResult.rows[0];

        // Odomknúť všetky jazdy v období
        await client.query(
            `UPDATE trips 
             SET period_locked = FALSE,
                 locked_at = NULL,
                 locked_by = NULL,
                 status = 'CONFIRMED'
             WHERE vehicle_id = $1
               AND DATE(start_time) BETWEEN $2 AND $3`,
            [lock.vehicle_id, lock.period_start, lock.period_end]
        );

        // Vymazať záznam zamknutia (alebo ho označiť ako odomknutý)
        await client.query(
            'DELETE FROM period_locks WHERE id = $1',
            [lock_id]
        );

        // Zalogovat odomknutie
        await client.query(
            `INSERT INTO trip_audit_log (trip_id, action, changed_by, new_value)
             SELECT 
                 id,
                 'UNLOCKED',
                 $1,
                 $2
             FROM trips
             WHERE vehicle_id = $3
               AND DATE(start_time) BETWEEN $4 AND $5`,
            [unlocked_by, unlock_reason, lock.vehicle_id, lock.period_start, lock.period_end]
        );

        await client.query('COMMIT');

        res.json({
            message: 'Obdobie úspešne odomknuté',
            affected_trips: lock.trips_count
        });

    } catch (err) {
        await client.query('ROLLBACK');
        console.error('Chyba pri odomykaní:', err);
        res.status(400).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * GET /api/periods/check-lockable - Skontrolovať, či je obdobie pripravené na zamknutie
 */
router.get('/check-lockable', async (req, res) => {
    try {
        const { vehicle_id, period_start, period_end } = req.query;

        if (!vehicle_id || !period_start || !period_end) {
            return res.status(400).json({
                error: 'Povinné parametre: vehicle_id, period_start, period_end'
            });
        }

        // Skontrolovať existujúce zamknutia
        const existingLocks = await db.query(
            `SELECT * FROM period_locks
             WHERE vehicle_id = $1
               AND period_start <= $3
               AND period_end >= $2`,
            [vehicle_id, period_start, period_end]
        );

        if (existingLocks.rows.length > 0) {
            return res.json({
                lockable: false,
                reason: 'Obdobie je už čiastočne alebo úplne zamknuté',
                existing_locks: existingLocks.rows
            });
        }

        // Skontrolovať nepotvrdené jazdy
        const unconfirmedTrips = await db.query(
            `SELECT COUNT(*) as count
             FROM trips
             WHERE vehicle_id = $1
               AND DATE(start_time) BETWEEN $2 AND $3
               AND status != 'CONFIRMED'`,
            [vehicle_id, period_start, period_end]
        );

        if (parseInt(unconfirmedTrips.rows[0].count) > 0) {
            return res.json({
                lockable: false,
                reason: 'V období existujú nepotvrdené jazdy',
                unconfirmed_count: parseInt(unconfirmedTrips.rows[0].count)
            });
        }

        // Získať štatistiky
        const stats = await db.query(
            `SELECT 
                COUNT(*) as total_trips,
                COUNT(*) FILTER (WHERE trip_type = 'business') as business_trips,
                COUNT(*) FILTER (WHERE trip_type = 'private') as private_trips,
                SUM(distance_meters) / 1000.0 as total_km
             FROM trips
             WHERE vehicle_id = $1
               AND DATE(start_time) BETWEEN $2 AND $3`,
            [vehicle_id, period_start, period_end]
        );

        res.json({
            lockable: true,
            stats: stats.rows[0]
        });

    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// EXPORT
// ============================================================================

/**
 * POST /api/export/csv - Export do CSV
 */
router.post('/csv', async (req, res) => {
    const client = await db.getClient();

    try {
        const {
            vehicle_id,
            driver_id,
            period_start,
            period_end,
            trip_type,
            generated_by
        } = req.body;

        // Zostaviť query
        let query = `
            SELECT 
                v.registration_plate,
                v.vin,
                CONCAT(d.first_name, ' ', d.last_name) as driver_name,
                TO_CHAR(t.start_time, 'DD.MM.YYYY HH24:MI') as start_time,
                TO_CHAR(t.end_time, 'DD.MM.YYYY HH24:MI') as end_time,
                t.start_address,
                t.end_address,
                ROUND(t.distance_meters / 1000.0, 2) as distance_km,
                ROUND(t.duration_seconds / 60.0, 0) as duration_minutes,
                CASE 
                    WHEN t.trip_type = 'business' THEN 'Služobná'
                    WHEN t.trip_type = 'private' THEN 'Privátna'
                    WHEN t.trip_type = 'commute' THEN 'Dochádzka'
                    ELSE 'Nepotvrdená'
                END as trip_type_label,
                t.trip_purpose,
                t.status
            FROM trips t
            LEFT JOIN vehicles v ON t.vehicle_id = v.id
            LEFT JOIN drivers d ON t.driver_id = d.id
            WHERE t.status = 'CONFIRMED' OR t.status = 'LOCKED'
        `;
        const params = [];
        let paramIndex = 1;

        if (vehicle_id) {
            params.push(vehicle_id);
            query += ` AND t.vehicle_id = $${paramIndex++}`;
        }
        if (driver_id) {
            params.push(driver_id);
            query += ` AND t.driver_id = $${paramIndex++}`;
        }
        if (period_start) {
            params.push(period_start);
            query += ` AND DATE(t.start_time) >= $${paramIndex++}`;
        }
        if (period_end) {
            params.push(period_end);
            query += ` AND DATE(t.start_time) <= $${paramIndex++}`;
        }
        if (trip_type) {
            params.push(trip_type);
            query += ` AND t.trip_type = $${paramIndex++}`;
        }

        query += ' ORDER BY t.start_time';

        const result = await client.query(query, params);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Žiadne jazdy na export' });
        }

        // Vytvoriť CSV
        const fields = [
            { label: 'EČV', value: 'registration_plate' },
            { label: 'VIN', value: 'vin' },
            { label: 'Vodič', value: 'driver_name' },
            { label: 'Začiatok', value: 'start_time' },
            { label: 'Koniec', value: 'end_time' },
            { label: 'Odkiaľ', value: 'start_address' },
            { label: 'Kam', value: 'end_address' },
            { label: 'Vzdialenosť (km)', value: 'distance_km' },
            { label: 'Trvanie (min)', value: 'duration_minutes' },
            { label: 'Typ jazdy', value: 'trip_type_label' },
            { label: 'Účel', value: 'trip_purpose' },
            { label: 'Status', value: 'status' }
        ];

        const json2csvParser = new Parser({ fields, delimiter: ';' });
        const csv = json2csvParser.parse(result.rows);

        // Uložiť do export histórie
        const filename = `kniha_jazd_${Date.now()}.csv`;
        const filePath = `/exports/${filename}`;

        await client.query(
            `INSERT INTO export_history (
                export_type, vehicle_id, driver_id,
                period_start, period_end, trip_type,
                trips_count, file_path, generated_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [
                'CSV', vehicle_id, driver_id,
                period_start, period_end, trip_type,
                result.rows.length, filePath, generated_by
            ]
        );

        // Poslať CSV
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.send('\uFEFF' + csv); // BOM pre správne zobrazenie diakritiky v Exceli

    } catch (err) {
        console.error('Chyba pri exporte CSV:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * POST /api/export/pdf - Export do PDF
 */
router.post('/pdf', async (req, res) => {
    const client = await db.getClient();

    try {
        const {
            vehicle_id,
            driver_id,
            period_start,
            period_end,
            trip_type,
            generated_by
        } = req.body;

        // Získať dáta (rovnaký query ako pre CSV)
        let query = `
            SELECT 
                v.registration_plate,
                v.vin,
                v.brand,
                v.model,
                CONCAT(d.first_name, ' ', d.last_name) as driver_name,
                t.start_time,
                t.end_time,
                t.start_address,
                t.end_address,
                t.distance_meters / 1000.0 as distance_km,
                t.duration_seconds / 60.0 as duration_minutes,
                t.trip_type,
                t.trip_purpose
            FROM trips t
            LEFT JOIN vehicles v ON t.vehicle_id = v.id
            LEFT JOIN drivers d ON t.driver_id = d.id
            WHERE t.status = 'CONFIRMED' OR t.status = 'LOCKED'
        `;
        const params = [];
        let paramIndex = 1;

        if (vehicle_id) {
            params.push(vehicle_id);
            query += ` AND t.vehicle_id = $${paramIndex++}`;
        }
        if (driver_id) {
            params.push(driver_id);
            query += ` AND t.driver_id = $${paramIndex++}`;
        }
        if (period_start) {
            params.push(period_start);
            query += ` AND DATE(t.start_time) >= $${paramIndex++}`;
        }
        if (period_end) {
            params.push(period_end);
            query += ` AND DATE(t.start_time) <= $${paramIndex++}`;
        }
        if (trip_type) {
            params.push(trip_type);
            query += ` AND t.trip_type = $${paramIndex++}`;
        }

        query += ' ORDER BY t.start_time';

        const result = await client.query(query, params);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Žiadne jazdy na export' });
        }

        // Vypočítať súhrny
        const totalKm = result.rows.reduce((sum, row) => sum + parseFloat(row.distance_km), 0);
        const businessKm = result.rows
            .filter(r => r.trip_type === 'business')
            .reduce((sum, row) => sum + parseFloat(row.distance_km), 0);
        const privateKm = result.rows
            .filter(r => r.trip_type === 'private')
            .reduce((sum, row) => sum + parseFloat(row.distance_km), 0);

        // Vytvoriť PDF
        const doc = new PDFDocument({ margin: 50, size: 'A4' });
        
        // Buffer pre uloženie PDF
        const chunks = [];
        doc.on('data', chunk => chunks.push(chunk));

        // Hlavička
        doc.fontSize(18).text('KNIHA JÁZD', { align: 'center' });
        doc.moveDown();

        // Informácie o vozidle
        if (result.rows[0].registration_plate) {
            doc.fontSize(12).text(`Vozidlo: ${result.rows[0].brand || ''} ${result.rows[0].model || ''}`);
            doc.text(`EČV: ${result.rows[0].registration_plate}`);
            if (result.rows[0].vin) {
                doc.text(`VIN: ${result.rows[0].vin}`);
            }
        }

        // Obdobie
        if (period_start && period_end) {
            doc.text(`Obdobie: ${period_start} - ${period_end}`);
        }

        doc.moveDown();

        // Súhrn
        doc.fontSize(14).text('SÚHRN:', { underline: true });
        doc.fontSize(10);
        doc.text(`Celkový počet jázd: ${result.rows.length}`);
        doc.text(`Celková vzdialenosť: ${totalKm.toFixed(2)} km`);
        doc.text(`Služobné jazdy: ${businessKm.toFixed(2)} km`);
        doc.text(`Privátne jazdy: ${privateKm.toFixed(2)} km`);

        doc.moveDown(2);

        // Tabuľka jázd
        doc.fontSize(12).text('ZOZNAM JÁZD:', { underline: true });
        doc.moveDown();

        doc.fontSize(8);
        result.rows.forEach((trip, index) => {
            const startTime = new Date(trip.start_time).toLocaleString('sk-SK');
            const tripType = trip.trip_type === 'business' ? 'Služobná' : 
                           trip.trip_type === 'private' ? 'Privátna' : 'Dochádzka';

            doc.text(`${index + 1}. ${startTime}`);
            doc.text(`   ${trip.start_address || 'N/A'} → ${trip.end_address || 'N/A'}`);
            doc.text(`   ${tripType}, ${trip.distance_km.toFixed(2)} km`);
            if (trip.trip_purpose) {
                doc.text(`   Účel: ${trip.trip_purpose}`);
            }
            doc.moveDown(0.5);

            // Nová strana po 25 jazdách
            if ((index + 1) % 25 === 0 && index < result.rows.length - 1) {
                doc.addPage();
            }
        });

        // Päta
        doc.moveDown(2);
        doc.fontSize(8).text(
            `Vygenerované: ${new Date().toLocaleString('sk-SK')}`,
            { align: 'center' }
        );

        doc.end();

        // Počkať na dokončenie PDF
        doc.on('end', async () => {
            const pdfBuffer = Buffer.concat(chunks);
            const filename = `kniha_jazd_${Date.now()}.pdf`;

            // Uložiť do histórie
            await client.query(
                `INSERT INTO export_history (
                    export_type, vehicle_id, driver_id,
                    period_start, period_end, trip_type,
                    trips_count, file_path, generated_by
                ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
                [
                    'PDF', vehicle_id, driver_id,
                    period_start, period_end, trip_type,
                    result.rows.length, `/exports/${filename}`, generated_by
                ]
            );

            // Poslať PDF
            res.setHeader('Content-Type', 'application/pdf');
            res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
            res.send(pdfBuffer);
        });

    } catch (err) {
        console.error('Chyba pri exporte PDF:', err);
        res.status(500).json({ error: err.message });
    } finally {
        client.release();
    }
});

/**
 * GET /api/export/history - História exportov
 */
router.get('/history', async (req, res) => {
    try {
        const { limit = 50 } = req.query;

        const result = await db.query(
            `SELECT 
                eh.*,
                v.name as vehicle_name,
                CONCAT(d.first_name, ' ', d.last_name) as generated_by_name
             FROM export_history eh
             LEFT JOIN vehicles v ON eh.vehicle_id = v.id
             LEFT JOIN drivers d ON eh.generated_by = d.id
             ORDER BY eh.generated_at DESC
             LIMIT $1`,
            [limit]
        );

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
