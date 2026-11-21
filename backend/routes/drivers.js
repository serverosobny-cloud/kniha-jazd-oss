const express = require('express');
const router = express.Router();
const db = require('../db');

// Získať všetkých vodičov
router.get('/', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT d.*, 
                    COUNT(DISTINCT t.id) as trips_count,
                    SUM(t.distance_meters) as total_distance
             FROM drivers d
             LEFT JOIN trips t ON d.id = t.driver_id
             GROUP BY d.id
             ORDER BY d.last_name, d.first_name`
        );
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Získať jedného vodiča
router.get('/:id', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM drivers WHERE id = $1',
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Vodič nenájdený' });
        }
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Vytvoriť nového vodiča
router.post('/', async (req, res) => {
    const { first_name, last_name, email, phone, license_number } = req.body;
    
    try {
        const result = await db.query(
            `INSERT INTO drivers (first_name, last_name, email, phone, license_number)
             VALUES ($1, $2, $3, $4, $5)
             RETURNING *`,
            [first_name, last_name, email, phone, license_number]
        );
        
        res.status(201).json(result.rows[0]);
    } catch (err) {
        if (err.code === '23505') { // Unique violation
            return res.status(400).json({ error: 'Vodič s týmto emailom už existuje' });
        }
        res.status(500).json({ error: err.message });
    }
});

// Aktualizovať vodiča
router.put('/:id', async (req, res) => {
    const { first_name, last_name, email, phone, license_number } = req.body;
    
    try {
        const result = await db.query(
            `UPDATE drivers 
             SET first_name = $1, last_name = $2, email = $3, phone = $4, license_number = $5
             WHERE id = $6
             RETURNING *`,
            [first_name, last_name, email, phone, license_number, req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Vodič nenájdený' });
        }
        
        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Vymazať vodiča
router.delete('/:id', async (req, res) => {
    try {
        const result = await db.query(
            'DELETE FROM drivers WHERE id = $1 RETURNING *',
            [req.params.id]
        );
        
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Vodič nenájdený' });
        }
        
        res.json({ message: 'Vodič vymazaný', driver: result.rows[0] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
