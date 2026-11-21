const express = require('express');
const router = express.Router();
const db = require('../db');
const traccarService = require('../services/traccar');

// Synchronizovať zariadenia z Traccar
router.post('/sync-devices', async (req, res) => {
    try {
        const result = await traccarService.syncDevices();
        res.json({
            message: 'Zariadenia synchronizované',
            ...result
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Importovať pozície z Traccar
router.post('/positions', async (req, res) => {
    try {
        const { hours = 24 } = req.body;

        const result = await traccarService.importRecentPositions(hours);

        res.json({
            message: 'Import dokončený',
            ...result
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Importovať jazdy (tripy) z Traccar
router.post('/trips', async (req, res) => {
    try {
        const { from, to } = req.body;

        // Default: last 7 days
        const toDate = to ? new Date(to) : new Date();
        const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

        const result = await traccarService.importAllTrips(fromDate, toDate);

        res.json({
            message: 'Import jázd dokončený',
            period: { from: fromDate.toISOString(), to: toDate.toISOString() },
            ...result
        });
    } catch (err) {
        console.error('Chyba pri importe jázd:', err);
        res.status(500).json({ error: err.message });
    }
});

// Získať históriu importov
router.get('/history', async (req, res) => {
    try {
        const { limit = 50 } = req.query;

        const result = await db.query(
            `SELECT * FROM import_log
             ORDER BY started_at DESC
             LIMIT $1`,
            [limit]
        );

        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Získať detail importu
router.get('/history/:id', async (req, res) => {
    try {
        const result = await db.query(
            'SELECT * FROM import_log WHERE id = $1',
            [req.params.id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Import log nenájdený' });
        }

        res.json(result.rows[0]);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

module.exports = router;
