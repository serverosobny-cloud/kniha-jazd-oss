const express = require('express');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
if (process.env.NODE_ENV !== 'production') {
    require('dotenv').config();
}

const db = require('./db');
const traccarService = require('./services/traccar');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (za Traefik reverse proxy)
app.set('trust proxy', 1);

// ============================================================================
// SECURITY MIDDLEWARE
// ============================================================================

// Helmet s CSP pre frontend (Google Fonts, Google Maps)
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'", "https://maps.googleapis.com"],
            styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
            fontSrc: ["'self'", "https://fonts.gstatic.com", "https://fonts.googleapis.com"],
            imgSrc: ["'self'", "data:", "blob:",
                      "https://maps.googleapis.com", "https://maps.gstatic.com", "https://*.ggpht.com",
                      "https://*.google.com", "https://*.googleusercontent.com"],
            connectSrc: ["'self'", "https://places.googleapis.com",
                         "https://maps.googleapis.com", "https://*.google.com"],
            frameSrc: ["'none'"],
            objectSrc: ["'none'"],
            workerSrc: ["'self'", "blob:"],
            // HTTPS rieši reverse proxy; inak by sa UI na http://server:3000 nenačítalo
            upgradeInsecureRequests: null
        }
    }
}));

// CORS konfigurácia
app.use(cors({
    origin: process.env.CORS_ORIGIN || false,
    credentials: true
}));

// Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minút
    max: 500, // max 500 requestov per IP (zvýšené pre SPA)
    message: 'Príliš veľa požiadaviek z tejto IP, skúste neskôr'
});
app.use('/api/', limiter);

// Basic auth — aplikácia nemá vlastné používateľské účty, takže bez tohto je
// každý údaj (jazdy, adresy, vodiči) verejný. Vypnúť len za vlastným SSO proxy.
const AUTH_USER = process.env.BASIC_AUTH_USER;
const AUTH_PASS = process.env.BASIC_AUTH_PASSWORD;
if (process.env.AUTH_DISABLED !== 'true' && (!AUTH_USER || !AUTH_PASS)) {
    console.error('Nastavte BASIC_AUTH_USER a BASIC_AUTH_PASSWORD (alebo AUTH_DISABLED=true za vlastným auth proxy).');
    process.exit(1);
}
const crypto = require('crypto');
const safeEqual = (a, b) => {
    const ha = crypto.createHash('sha256').update(a).digest();
    const hb = crypto.createHash('sha256').update(b).digest();
    return crypto.timingSafeEqual(ha, hb);
};
app.use((req, res, next) => {
    if (process.env.AUTH_DISABLED === 'true' || req.path === '/health') return next();
    const [scheme, encoded] = (req.headers.authorization || '').split(' ');
    if (scheme === 'Basic' && encoded) {
        const decoded = Buffer.from(encoded, 'base64').toString();
        const i = decoded.indexOf(':');
        const userOk = safeEqual(decoded.slice(0, Math.max(i, 0)), AUTH_USER);
        const passOk = safeEqual(decoded.slice(i + 1), AUTH_PASS);
        if (i > 0 && userOk && passOk) return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Kniha jazd", charset="UTF-8"').status(401).send('Unauthorized');
});

// Body parsing
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Static files - frontend SPA
app.use(express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.js') || filePath.endsWith('.css')) {
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('CDN-Cache-Control', 'no-store');
        }
    }
}));

// Request logging middleware (only API requests)
app.use('/api', (req, res, next) => {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
    next();
});

// ============================================================================
// ROUTES
// ============================================================================

// Health check
app.get('/health', async (req, res) => {
    try {
        await db.query('SELECT 1');
        res.json({
            status: 'ok',
            timestamp: new Date(),
            database: 'connected',
            version: '3.0.0'
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            timestamp: new Date(),
            database: 'disconnected',
            error: error.message
        });
    }
});

// API routes
app.use('/api/vehicles', require('./routes/vehicles'));
app.use('/api/drivers', require('./routes/drivers'));
app.use('/api/trips', require('./routes/trips_enhanced'));
app.use('/api/import', require('./routes/import'));
app.use('/api/statistics', require('./routes/statistics'));
app.use('/api/geofence', require('./routes/geofence'));
app.use('/api/periods', require('./routes/periods'));
app.use('/api/places', require('./routes/places'));

// ============================================================================
// AUTOMATICKÉ JOBY
// ============================================================================

/**
 * Automatický import pozícií z Traccar každých 15 minút
 */
cron.schedule('*/15 * * * *', async () => {
    console.log('Spúšťam automatický import pozícií z Traccar...');
    try {
        const result = await traccarService.importRecentPositions(1);
        console.log(`Import pozícií dokončený: ${result.inserted} nových, ${result.updated} aktualizovaných`);
    } catch (error) {
        console.error('Chyba pri automatickom importe pozícií:', error.message);
    }
});

/**
 * Automatický import jázd z Traccar každú hodinu
 */
cron.schedule('0 * * * *', async () => {
    console.log('Spúšťam automatický import jázd z Traccar...');
    try {
        const to = new Date();
        const from = new Date(to.getTime() - 2 * 60 * 60 * 1000); // posledné 2 hodiny (overlap)
        const result = await traccarService.importAllTrips(from, to);
        console.log(`Import jázd dokončený: ${result.inserted} nových, ${result.skipped} preskočených`);
    } catch (error) {
        console.error('Chyba pri automatickom importe jázd:', error.message);
    }
});

/**
 * Upomienky na nepotvrdené jazdy (každý deň o 18:00)
 */
cron.schedule('0 18 * * *', async () => {
    console.log('Kontrolujem nepotvrdené jazdy...');
    try {
        const result = await db.query(`
            SELECT
                v.name as vehicle_name,
                COUNT(*) as unconfirmed_count
            FROM trips t
            JOIN vehicles v ON t.vehicle_id = v.id
            WHERE t.status = 'UNCONFIRMED'
                AND t.start_time < NOW() - INTERVAL '24 hours'
            GROUP BY v.id, v.name
            HAVING COUNT(*) > 0
        `);

        if (result.rows.length > 0) {
            console.log('Nepotvrdené jazdy staršie ako 24h:');
            result.rows.forEach(row => {
                console.log(`   ${row.vehicle_name}: ${row.unconfirmed_count} jázd`);
            });
        } else {
            console.log('Všetky jazdy sú potvrdené');
        }
    } catch (error) {
        console.error('Chyba pri kontrole jázd:', error.message);
    }
});

/**
 * Cleanup starých pozícií (každú nedeľu o 2:00)
 */
cron.schedule('0 2 * * 0', async () => {
    console.log('Čistenie starých GPS pozícií...');
    try {
        const daysToKeep = parseInt(process.env.POSITION_RETENTION_DAYS, 10) || 90;

        const result = await db.query(
            `DELETE FROM positions
             WHERE device_time < NOW() - INTERVAL '1 day' * $1
             RETURNING id`,
            [daysToKeep]
        );

        console.log(`Vymazané ${result.rowCount} starých pozícií`);
    } catch (error) {
        console.error('Chyba pri čistení pozícií:', error.message);
    }
});

// ============================================================================
// ERROR HANDLING
// ============================================================================

// 404 handler - API only, let SPA handle frontend routes
app.use('/api', (req, res) => {
    res.status(404).json({
        error: 'Endpoint nenájdený',
        path: req.path
    });
});

// SPA fallback - serve index.html for all non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler
app.use((err, req, res, next) => {
    console.error('Server error:', err);

    if (err.code === '23505') {
        return res.status(400).json({
            error: 'Duplicitný záznam',
            detail: err.detail
        });
    }

    if (err.code === '23503') {
        return res.status(400).json({
            error: 'Referencovaný záznam neexistuje',
            detail: err.detail
        });
    }

    if (err.code === '23514') {
        return res.status(400).json({
            error: 'Validačná chyba',
            detail: err.detail
        });
    }

    res.status(500).json({
        error: 'Nastala chyba na serveri',
        message: process.env.NODE_ENV === 'development' ? err.message : 'Interná chyba servera'
    });
});

// ============================================================================
// GRACEFUL SHUTDOWN
// ============================================================================

process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        db.pool.end(() => {
            console.log('Database pool closed');
            process.exit(0);
        });
    });
});

process.on('SIGINT', () => {
    console.log('SIGINT signal received: closing HTTP server');
    server.close(() => {
        console.log('HTTP server closed');
        db.pool.end(() => {
            console.log('Database pool closed');
            process.exit(0);
        });
    });
});

// ============================================================================
// SERVER START
// ============================================================================

const server = app.listen(PORT, () => {
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('  KNIHA JÁZD v3.0 - Backend + Frontend');
    console.log('═══════════════════════════════════════════');
    console.log('');
    console.log(`Server beží na porte ${PORT}`);
    console.log(`Databáza: ${process.env.DATABASE_URL ? 'Pripojená' : 'Nekonfigurovaná'}`);
    console.log(`Frontend: ${path.join(__dirname, 'public')}`);
    console.log('');
    console.log('Cron joby:');
    console.log('  */15 * * * *  Import pozícií z Traccar');
    console.log('  0 * * * *     Import jázd z Traccar');
    console.log('  0 18 * * *    Kontrola nepotvrdených jázd');
    console.log('  0 2 * * 0     Cleanup starých pozícií');
    console.log('');
    console.log('═══════════════════════════════════════════');
    console.log('');
});

module.exports = app;
