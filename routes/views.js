const express = require('express');
const router = express.Router();
const settingsUtil = require('../utils/settings');
const bindConfig = require('../utils/bindConfig');

// List views
router.get('/', async (req, res) => {
    try {
        const settings = await settingsUtil.loadSettings();
        const views = settings.resolver?.views || [];
        res.render('views/list', { title: 'ACL Views', views, success: req.query.success, error: req.query.error });
    } catch (error) {
        res.render('views/list', { title: 'ACL Views', views: [], error: error.message });
    }
});

// Create new view form
router.get('/new', (req, res) => {
    res.render('views/new', { title: 'Create View' });
});

// Create new view
router.post('/', async (req, res) => {
    try {
        const { name, allow, deny } = req.body;
        if (!name) throw new Error('View name required');

        const settings = await settingsUtil.loadSettings();
        const views = settings.resolver?.views || [];
        if (views.find(v => v.name === name)) {
            return res.redirect('/views?error=' + encodeURIComponent('View already exists'));
        }

        const newView = {
            name,
            acl: {
                allow: allow ? allow.split('\n').map(s => s.trim()).filter(s => s) : ['any'],
                deny: deny ? deny.split('\n').map(s => s.trim()).filter(s => s) : []
            },
            zones: []
        };

        views.push(newView);
        await settingsUtil.updateSettings({ resolver: { views } });

        // Add view to named.conf.local
        await bindConfig.addViewToConfig(name, newView.acl);

        res.redirect('/views?success=' + encodeURIComponent('View created'));
    } catch (error) {
        console.error('Error creating view:', error);
        res.redirect('/views?error=' + encodeURIComponent(error.message));
    }
});

// Edit view form
router.get('/:name/edit', async (req, res) => {
    try {
        const settings = await settingsUtil.loadSettings();
        const views = settings.resolver?.views || [];
        const view = views.find(v => v.name === req.params.name);
        if (!view) throw new Error('View not found');
        res.render('views/edit', { title: `Edit View: ${view.name}`, view });
    } catch (error) {
        res.redirect('/views?error=' + encodeURIComponent(error.message));
    }
});

// Update view
router.post('/:name', async (req, res) => {
    try {
        const name = req.params.name;
        const { allow, deny } = req.body;
        const settings = await settingsUtil.loadSettings();
        const views = settings.resolver?.views || [];
        const viewIndex = views.findIndex(v => v.name === name);
        if (viewIndex === -1) throw new Error('View not found');

        views[viewIndex].acl.allow = allow ? allow.split('\n').map(s => s.trim()).filter(s => s) : ['any'];
        views[viewIndex].acl.deny = deny ? deny.split('\n').map(s => s.trim()).filter(s => s) : [];

        await settingsUtil.updateSettings({ resolver: { views } });

        // Re-create the view block in named.conf.local to update ACLs and keep assigned zones
        try {
            const bindConfig = require('../utils/bindConfig');
            // Remove existing view block
            await bindConfig.removeViewFromConfig(name);
            // Re-add view block with updated ACL
            await bindConfig.addViewToConfig(name, views[viewIndex].acl);
            // Re-add any zones assigned to this view back into the newly created view
            if (views[viewIndex].zones && views[viewIndex].zones.length > 0) {
                for (const zoneName of views[viewIndex].zones) {
                    const zoneFile = `/etc/bind/zones/db.${zoneName.replace(/\.$/, '')}`;
                    await bindConfig.addZoneToViewConfig(zoneName, zoneFile, name, views[viewIndex].acl);
                }
            }
        } catch (err) {
            console.warn(`Warning: Could not update named.conf.local while editing view ${name}: ${err.message}`);
        }
        res.redirect('/views?success=' + encodeURIComponent('View updated'));
    } catch (error) {
        console.error('Error updating view:', error);
        res.redirect('/views?error=' + encodeURIComponent(error.message));
    }
});

// Delete view
router.post('/:name/delete', async (req, res) => {
    try {
        const name = req.params.name;
        const settings = await settingsUtil.loadSettings();
        const views = settings.resolver?.views || [];
        const viewIndex = views.findIndex(v => v.name === name);
        if (viewIndex === -1) throw new Error('View not found');

        // Fail if view has zones; require user to reassign/delete zones first
        if (views[viewIndex].zones && views[viewIndex].zones.length > 0) {
            throw new Error('Cannot delete view that has zones assigned. Please reassign or delete zones first.');
        }

        views.splice(viewIndex, 1);
        await settingsUtil.updateSettings({ resolver: { views } });
        await bindConfig.removeViewFromConfig(name);
        res.redirect('/views?success=' + encodeURIComponent('View deleted'));
    } catch (error) {
        console.error('Error deleting view:', error);
        res.redirect('/views?error=' + encodeURIComponent(error.message));
    }
});

module.exports = router;
