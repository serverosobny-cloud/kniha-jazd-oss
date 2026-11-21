const express = require('express');
const router = express.Router();
const db = require('../db');

// ============================================================================
// GEOFENCE ZÓNY
// ============================================================================

/**
 * GET /api/geofence/zones - Získať všetky zóny
 */
router.get('/zones', async (req, res) => {
    try {
        const { active, zone_type } = req.query;

        let query = 'SELECT * FROM geofence_zones WHERE 1=1';
        const params = [];
        let paramIndex = 1;

        if (active !== undefined) {
            params.push(active === 'true');
            query += ` AND active = $${paramIndex++}`;
        }

        if (zone_type) {
            params.push(zone_type);
            query += ` AND zone_type = $${paramIndex++}`;
        }

        query += ' ORDER BY zone_type, name';

        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/geofence/zones/:id - Detail zóny
 */
router.get('/zones/:id', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM geofence_zones WHERE id = $1',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Zóna nenájdená' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/geofence/zones - Vytvoriť novú zónu
 */
router.post('/zones', async (req, res) => {
    try {
        const {
            name,
            description,
            latitude,
            longitude,
            radius_meters = 100,
            zone_type,
            color = '#3498db',
            created_by
        } = req.body;

        // Validácia
        if (!name || !latitude || !longitude || !zone_type) {
            return res.status(400).json({
                error: 'Povinné polia: name, latitude, longitude, zone_type'
            });
        }

        if (radius_meters < 1 || radius_meters > 5000) {
            return res.status(400).json({
                error: 'Polomer musí byť medzi 1 a 5000 metrov'
            });
        }

        const validTypes = ['home', 'office', 'client', 'warehouse', 'other'];
        if (!validTypes.includes(zone_type)) {
            return res.status(400).json({
                error: `Typ zóny musí byť jeden z: ${validTypes.join(', ')}`
            });
        }

        const result = await db.query(
            `INSERT INTO geofence_zones (
                name, description, latitude, longitude,
                radius_meters, zone_type, color, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING *`,
            [name, description, latitude, longitude, radius_meters, zone_type, color, created_by]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/geofence/zones/:id - Aktualizovať zónu
 */
router.put('/zones/:id', async (req, res) => {
    try {
        const {
            name,
            description,
            latitude,
            longitude,
            radius_meters,
            zone_type,
            color,
            active
        } = req.body;

        const result = await db.query(
            `UPDATE geofence_zones 
             SET name = COALESCE($1, name),
                 description = COALESCE($2, description),
                 latitude = COALESCE($3, latitude),
                 longitude = COALESCE($4, longitude),
                 radius_meters = COALESCE($5, radius_meters),
                 zone_type = COALESCE($6, zone_type),
                 color = COALESCE($7, color),
                 active = COALESCE($8, active)
             WHERE id = $9
             RETURNING *`,
            [name, description, latitude, longitude, radius_meters, zone_type, color, active, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Zóna nenájdená' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/geofence/zones/:id - Vymazať zónu
 */
router.delete('/zones/:id', async (req, res) => {
    try {
        const result = await db.query(
            'DELETE FROM geofence_zones WHERE id = $1 RETURNING *',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Zóna nenájdená' });
        }

        res.json({
            message: 'Zóna vymazaná',
            zone: result.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/geofence/zones/find - Nájsť zónu pre GPS súradnice
 */
router.post('/zones/find', async (req, res) => {
    try {
        const { latitude, longitude } = req.body;

        if (!latitude || !longitude) {
            return res.status(400).json({
                error: 'Povinné polia: latitude, longitude'
            });
        }

        const result = await db.query(
            'SELECT find_geofence_zone($1, $2) as zone_id',
            [latitude, longitude]
        );

        const zoneId = result.rows[0].zone_id;

        if (!zoneId) {
            return res.json({
                zone: null,
                message: 'Žiadna zóna nenájdená pre tieto súradnice'
            });
        }

        // Získať detail zóny
        const zoneResult = await db.query(
            'SELECT * FROM geofence_zones WHERE id = $1',
            [zoneId]
        );

        res.json({
            zone: zoneResult.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ============================================================================
// KLASIFIKAČNÉ PRAVIDLÁ
// ============================================================================

/**
 * GET /api/geofence/rules - Získať všetky pravidlá
 */
router.get('/rules', async (req, res) => {
    try {
        const { active } = req.query;

        let query = `
            SELECT 
                cr.*,
                sz.name as start_zone_name,
                ez.name as end_zone_name
            FROM classification_rules cr
            LEFT JOIN geofence_zones sz ON cr.start_zone_id = sz.id
            LEFT JOIN geofence_zones ez ON cr.end_zone_id = ez.id
            WHERE 1=1
        `;
        const params = [];
        let paramIndex = 1;

        if (active !== undefined) {
            params.push(active === 'true');
            query += ` AND cr.active = $${paramIndex++}`;
        }

        query += ' ORDER BY cr.priority DESC, cr.rule_name';

        const result = await db.query(query, params);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/geofence/rules/:id - Detail pravidla
 */
router.get('/rules/:id', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT 
                cr.*,
                sz.name as start_zone_name,
                ez.name as end_zone_name
             FROM classification_rules cr
             LEFT JOIN geofence_zones sz ON cr.start_zone_id = sz.id
             LEFT JOIN geofence_zones ez ON cr.end_zone_id = ez.id
             WHERE cr.id = $1`,
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Pravidlo nenájdené' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/geofence/rules - Vytvoriť nové pravidlo
 */
router.post('/rules', async (req, res) => {
    try {
        const {
            rule_name,
            start_zone_id,
            end_zone_id,
            suggested_trip_type,
            suggested_purpose,
            priority = 0
        } = req.body;

        // Validácia
        if (!rule_name || !suggested_trip_type) {
            return res.status(400).json({
                error: 'Povinné polia: rule_name, suggested_trip_type'
            });
        }

        const validTypes = ['business', 'private', 'commute'];
        if (!validTypes.includes(suggested_trip_type)) {
            return res.status(400).json({
                error: `Typ jazdy musí byť jeden z: ${validTypes.join(', ')}`
            });
        }

        const result = await db.query(
            `INSERT INTO classification_rules (
                rule_name, start_zone_id, end_zone_id,
                suggested_trip_type, suggested_purpose, priority
            ) VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *`,
            [rule_name, start_zone_id, end_zone_id, suggested_trip_type, suggested_purpose, priority]
        );

        res.status(201).json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * PUT /api/geofence/rules/:id - Aktualizovať pravidlo
 */
router.put('/rules/:id', async (req, res) => {
    try {
        const {
            rule_name,
            start_zone_id,
            end_zone_id,
            suggested_trip_type,
            suggested_purpose,
            priority,
            active
        } = req.body;

        const result = await db.query(
            `UPDATE classification_rules 
             SET rule_name = COALESCE($1, rule_name),
                 start_zone_id = COALESCE($2, start_zone_id),
                 end_zone_id = COALESCE($3, end_zone_id),
                 suggested_trip_type = COALESCE($4, suggested_trip_type),
                 suggested_purpose = COALESCE($5, suggested_purpose),
                 priority = COALESCE($6, priority),
                 active = COALESCE($7, active)
             WHERE id = $8
             RETURNING *`,
            [rule_name, start_zone_id, end_zone_id, suggested_trip_type, suggested_purpose, priority, active, req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Pravidlo nenájdené' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * DELETE /api/geofence/rules/:id - Vymazať pravidlo
 */
router.delete('/rules/:id', async (req, res) => {
    try {
        const result = await db.query(
            'DELETE FROM classification_rules WHERE id = $1 RETURNING *',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Pravidlo nenájdené' });
        }

        res.json({
            message: 'Pravidlo vymazané',
            rule: result.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * POST /api/geofence/suggest - Získať návrh klasifikácie pre zóny
 */
router.post('/suggest', async (req, res) => {
    try {
        const { start_zone_id, end_zone_id } = req.body;

        const result = await db.query(
            'SELECT * FROM suggest_trip_classification($1, $2)',
            [start_zone_id, end_zone_id]
        );

        if (result.rows.length === 0) {
            return res.json({
                suggestion: null,
                message: 'Žiadne pravidlo nenájdené pre túto kombináciu zón'
            });
        }

        res.json({
            suggestion: result.rows[0]
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

/**
 * GET /api/geofence/statistics - Štatistiky využitia geofence zón
 */
router.get('/statistics', async (req, res) => {
    try {
        const { from, to } = req.query;

        let dateFilter = '';
        const params = [];

        if (from && to) {
            dateFilter = 'AND t.start_time >= $1 AND t.start_time <= $2';
            params.push(from, to);
        }

        const result = await db.query(`
            SELECT 
                gz.id,
                gz.name,
                gz.zone_type,
                COUNT(DISTINCT t1.id) as trips_starting_here,
                COUNT(DISTINCT t2.id) as trips_ending_here,
                COUNT(DISTINCT t1.id) + COUNT(DISTINCT t2.id) as total_trips
            FROM geofence_zones gz
            LEFT JOIN trips t1 ON gz.id = t1.start_zone_id ${dateFilter}
            LEFT JOIN trips t2 ON gz.id = t2.end_zone_id ${dateFilter}
            GROUP BY gz.id, gz.name, gz.zone_type
            HAVING COUNT(DISTINCT t1.id) + COUNT(DISTINCT t2.id) > 0
            ORDER BY total_trips DESC
        `, params);

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
