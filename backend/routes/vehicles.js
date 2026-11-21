const express = require('express');
const router = express.Router();
const db = require('../db');

// Získať všetky vozidlá
router.get('/', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT v.*,
                    COUNT(DISTINCT t.id) as trips_count,
                    COALESCE(SUM(t.distance_meters), 0) as total_distance
             FROM vehicles v
             LEFT JOIN trips t ON v.id = t.vehicle_id AND t.merged_into_id IS NULL
             GROUP BY v.id
             ORDER BY v.name`
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Získať jedno vozidlo
router.get('/:id', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM vehicles WHERE id = $1',
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Vozidlo nenájdené' });
        }
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Vytvoriť nové vozidlo
router.post('/', async (req, res) => {
    const { traccar_device_id, name, registration_plate, vin, brand, model, year, fuel_type, initial_odometer } = req.body;

    try {
        const result = await db.query(
            `INSERT INTO vehicles (traccar_device_id, name, registration_plate, vin, brand, model, year, fuel_type, initial_odometer)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             RETURNING *`,
            [traccar_device_id, name, registration_plate, vin, brand, model, year, fuel_type, initial_odometer || 0]
        );
        
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') { // Unique violation
            return res.status(400).json({ error: 'Vozidlo s týmto Traccar device ID už existuje' });
        }
        res.status(500).json({ error: err.message });
    }
});

// Aktualizovať vozidlo
router.put('/:id', async (req, res) => {
    const { name, registration_plate, vin, brand, model, year, fuel_type, initial_odometer } = req.body;

    try {
        const oldVehicle = await db.query('SELECT initial_odometer FROM vehicles WHERE id = $1', [req.params.id]);
        const result = await db.query(
            `UPDATE vehicles
             SET name = $1, registration_plate = $2, vin = $3, brand = $4,
                 model = $5, year = $6, fuel_type = $7, initial_odometer = $8
             WHERE id = $9
             RETURNING *`,
            [name, registration_plate, vin, brand, model, year, fuel_type, initial_odometer || 0, req.params.id]
        );

        // Ak sa zmenil initial_odometer, prepočítať odometer pre jazdy
        if (oldVehicle.rows[0] && parseFloat(oldVehicle.rows[0].initial_odometer) !== parseFloat(initial_odometer || 0)) {
            db.query('SELECT recalculate_odometers($1)', [req.params.id]).catch(() => {});
        }
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Vozidlo nenájdené' });
        }
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Vymazať vozidlo
router.delete('/:id', async (req, res) => {
    try {
        const result = await db.query(
            'DELETE FROM vehicles WHERE id = $1 RETURNING *',
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Vozidlo nenájdené' });
        }
        
        res.json({ message: 'Vozidlo vymazané', vehicle: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// VEHICLE DEVICES (multi-device support)
// ============================================================================

// Získať zariadenia pre vozidlo
router.get('/:id/devices', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM vehicle_devices WHERE vehicle_id = $1 ORDER BY created_at',
            [req.params.id]
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Priradiť zariadenie k vozidlu
router.post('/:id/devices', async (req, res) => {
    try {
        const { traccar_device_id, device_name } = req.body;
        if (!traccar_device_id) {
            return res.status(400).json({ error: 'traccar_device_id je povinný' });
        }
        const result = await db.query(
            `INSERT INTO vehicle_devices (vehicle_id, traccar_device_id, device_name)
             VALUES ($1, $2, $3)
             ON CONFLICT (vehicle_id, traccar_device_id) DO UPDATE SET device_name = EXCLUDED.device_name
             RETURNING *`,
            [req.params.id, traccar_device_id, device_name]
        );
        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Odstrániť zariadenie z vozidla
router.delete('/:vehicleId/devices/:deviceId', async (req, res) => {
    try {
        const result = await db.query(
            'DELETE FROM vehicle_devices WHERE vehicle_id = $1 AND id = $2 RETURNING *',
            [req.params.vehicleId, req.params.deviceId]
        );
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Zariadenie nenájdené' });
        }
        res.json({ message: 'Zariadenie odstránené', device: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
