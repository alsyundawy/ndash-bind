const express = require('express');
const router = express.Router();
const moment = require('moment');
const bindService = require('../services/bindService');
const settingsUtil = require('../utils/settings');

// List all zones
router.get('/', async (req, res) => {
    try {
        const zones = await bindService.listZones();
        const settings = await settingsUtil.loadSettings();
        const views = settings.resolver?.views || [];

        res.render('zones/list', {
            title: 'DNS Zones',
            zones: zones,
            views,
            moment,
            error: req.query.error,
            success: req.query.success
        });
    } catch (error) {
        console.error('Error listing zones:', error);
        const settings2 = await settingsUtil.loadSettings().catch(()=>({}));
        const views2 = settings2.resolver?.views || [];
        res.render('zones/list', {
            title: 'DNS Zones',
            zones: [],
            views: views2,
            moment,
            error: 'Failed to load zones: ' + error.message
        });
    }
});

// View zone details
router.get('/:zoneName', async (req, res) => {
    try {
        const zoneName = req.params.zoneName;
        const { zone, records } = await bindService.getZone(zoneName);

        res.render('zones/detail', {
            title: `Zone: ${zone.name}`,
            zone,
            records: records,
            moment,
            error: req.query.error,
            success: req.query.success
        });
    } catch (error) {
        console.error('Error loading zone:', error);
        res.status(404).render('error', {
            title: 'Zone Not Found',
            message: error.message
        });
    }
});

// Add new zone (GET form)
router.get('/new/create', async (req, res) => {
    const settingsUtil = require('../utils/settings');
    const settings = await settingsUtil.loadSettings();
    res.render('zones/new', {
        title: 'Create New Zone',
        views: settings.resolver?.views || []
    });
});

// Add new zone (POST)
router.post('/', async (req, res) => {
    try {
        // Trim all input values to remove leading/trailing whitespace
        const name = (req.body.name || '').trim();
        const type = (req.body.type || '').trim();
        const nameserver = (req.body.nameserver || '').trim();
        const email = (req.body.email || '').trim();
        const domain = (req.body.domain || '').trim();
        
        if (!name) {
            return res.redirect('/zones/new/create?error=' + encodeURIComponent('Zone name is required'));
        }
        
        // Validate zone name doesn't contain spaces
        if (name.includes(' ')) {
            return res.redirect('/zones/new/create?error=' + encodeURIComponent('Zone name cannot contain spaces'));
        }
        
        const zoneData = {
            name: name,
            type: type || 'master',
            nameserver: nameserver || `ns1.${name}.`,
            email: email || `admin.${name}.`
        };
        if (req.body.view) zoneData.view = req.body.view;
        
        // Add domain for reverse zones
        if (domain && name.includes('in-addr.arpa')) {
            zoneData.domain = domain;
        }
        
        const result = await bindService.createZone(zoneData);
        
        console.log('Zone created:', result);
        res.redirect(`/zones/${name}?success=` + encodeURIComponent(`Zone ${name} created successfully`));
    } catch (error) {
        console.error('Error creating zone:', error);
        res.redirect('/zones/new/create?error=' + encodeURIComponent(error.message));
    }
});

// Delete zone
router.post('/:zoneName/delete', async (req, res) => {
    try {
        const zoneName = req.params.zoneName;
        await bindService.deleteZone(zoneName);
        res.redirect('/zones?success=' + encodeURIComponent(`Zone ${zoneName} deleted successfully`));
    } catch (error) {
        console.error('Error deleting zone:', error);
        res.redirect('/zones?error=' + encodeURIComponent(error.message));
    }
});

// Reassign zone to different view
router.post('/:zoneName/reassign', async (req, res) => {
    try {
        const zoneName = req.params.zoneName;
        const newViewRaw = (req.body.view || '').trim();
        const newView = newViewRaw === '' ? 'global' : newViewRaw;
        await bindService.reassignZone(zoneName, newView);
        res.redirect('/zones?success=' + encodeURIComponent(`Zone ${zoneName} moved to ${newView || 'global'}`));
    } catch (error) {
        console.error('Error reassigning zone:', error);
        res.redirect('/zones?error=' + encodeURIComponent(error.message));
    }
});

// Reload Bind
router.post('/reload', async (req, res) => {
    try {
        await bindService.reloadBind();
        res.json({ success: true, message: 'Bind reloaded successfully' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

module.exports = router;
