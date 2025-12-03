const express = require('express');
const router = express.Router();
const bindService = require('../services/bindService');

/**
 * GET /acl - Display ACL management page
 */
router.get('/', async (req, res) => {
    try {
        const acls = await bindService.listACLs();
        
        res.render('acl/index', {
            title: 'ACL Management - NDash',
            acls,
            successMessage: req.query.success ? decodeURIComponent(req.query.success) : null,
            errorMessage: req.query.error ? decodeURIComponent(req.query.error) : null
        });
    } catch (error) {
        console.error('Error loading ACL page:', error);
        res.render('acl/index', {
            title: 'ACL Management - NDash',
            acls: [],
            errorMessage: 'Failed to load ACLs: ' + error.message
        });
    }
});

/**
 * GET /acl/api/list - API endpoint to get all ACLs
 */
router.get('/api/list', async (req, res) => {
    try {
        const acls = await bindService.listACLs();
        res.json({
            success: true,
            data: acls
        });
    } catch (error) {
        console.error('Error fetching ACLs:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /acl/api/create - Create a new ACL
 */
router.post('/api/create', async (req, res) => {
    try {
        const { name, entries, description } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                error: 'ACL name is required'
            });
        }

        if (!entries || !Array.isArray(entries) || entries.length === 0) {
            return res.status(400).json({
                success: false,
                error: 'At least one entry is required'
            });
        }

        // Validate each entry has an address
        for (const entry of entries) {
            if (!entry.address) {
                return res.status(400).json({
                    success: false,
                    error: 'All entries must have an address'
                });
            }
        }

        const result = await bindService.createACL(name, entries, description);
        res.json(result);
    } catch (error) {
        console.error('Error creating ACL:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /acl/api/delete - Delete an ACL
 */
router.post('/api/delete', async (req, res) => {
    try {
        const { name } = req.body;

        if (!name) {
            return res.status(400).json({
                success: false,
                error: 'ACL name is required'
            });
        }

        const result = await bindService.deleteACL(name);
        res.json(result);
    } catch (error) {
        console.error('Error deleting ACL:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /acl/api/master-zones - Get all master zones
 */
router.get('/api/master-zones', async (req, res) => {
    try {
        const masterZones = await bindService.getMasterZones();
        res.json({
            success: true,
            data: masterZones
        });
    } catch (error) {
        console.error('Error fetching master zones:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * GET /acl/api/slave-zones - Get all slave zones
 */
router.get('/api/slave-zones', async (req, res) => {
    try {
        const slaveZones = await bindService.getSlaveZones();
        res.json({
            success: true,
            data: slaveZones
        });
    } catch (error) {
        console.error('Error fetching slave zones:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /acl/api/convert-to-slave - Convert zone to slave
 */
router.post('/api/convert-to-slave', async (req, res) => {
    try {
        const { zoneName, masterIp, allowTransferAcl } = req.body;

        if (!zoneName || !masterIp) {
            return res.status(400).json({
                success: false,
                error: 'Zone name and master IP are required'
            });
        }

        const result = await bindService.convertToSlaveZone(zoneName, masterIp, allowTransferAcl || 'none');
        res.json(result);
    } catch (error) {
        console.error('Error converting to slave zone:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /acl/api/convert-to-master - Convert zone to master
 */
router.post('/api/convert-to-master', async (req, res) => {
    try {
        const { zoneName, file } = req.body;

        if (!zoneName || !file) {
            return res.status(400).json({
                success: false,
                error: 'Zone name and zone file are required'
            });
        }

        const result = await bindService.convertToMasterZone(zoneName, file);
        res.json(result);
    } catch (error) {
        console.error('Error converting to master zone:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /acl/api/update-slave-master - Update slave zone master
 */
router.post('/api/update-slave-master', async (req, res) => {
    try {
        const { zoneName, masterIp } = req.body;

        if (!zoneName || !masterIp) {
            return res.status(400).json({
                success: false,
                error: 'Zone name and master IP are required'
            });
        }

        const result = await bindService.updateSlaveZoneMaster(zoneName, masterIp);
        res.json(result);
    } catch (error) {
        console.error('Error updating slave zone master:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * POST /acl/api/set-allow-transfer - Set allow-transfer ACL for zone
 */
router.post('/api/set-allow-transfer', async (req, res) => {
    try {
        const { zoneName, aclName } = req.body;

        if (!zoneName || !aclName) {
            return res.status(400).json({
                success: false,
                error: 'Zone name and ACL name are required'
            });
        }

        const result = await bindService.setZoneAllowTransfer(zoneName, aclName);
        res.json(result);
    } catch (error) {
        console.error('Error setting zone allow-transfer:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
