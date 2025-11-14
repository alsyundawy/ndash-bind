const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');

// Activity log file path
const ACTIVITY_LOG_FILE = path.join(__dirname, '../data/activity.log');

/**
 * Parse activity log file
 */
async function getActivityLogs(filter = {}) {
    try {
        // Ensure log file exists
        try {
            await fs.access(ACTIVITY_LOG_FILE);
        } catch {
            // Create empty log file if doesn't exist
            await fs.writeFile(ACTIVITY_LOG_FILE, '', 'utf8');
            return [];
        }

        const content = await fs.readFile(ACTIVITY_LOG_FILE, 'utf8');
        if (!content.trim()) {
            return [];
        }

        const lines = content.trim().split('\n');
        const activities = [];

        for (const line of lines) {
            try {
                const activity = JSON.parse(line);
                activities.push(activity);
            } catch (err) {
                console.error('Error parsing activity log line:', err);
            }
        }

        // Sort by timestamp descending (newest first)
        activities.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

        // Apply filters
        let filtered = activities;

        if (filter.type && filter.type !== 'all') {
            filtered = filtered.filter(a => a.type === filter.type);
        }

        if (filter.action && filter.action !== 'all') {
            filtered = filtered.filter(a => a.action === filter.action);
        }

        if (filter.zone) {
            filtered = filtered.filter(a => 
                a.zone && a.zone.toLowerCase().includes(filter.zone.toLowerCase())
            );
        }

        if (filter.limit) {
            filtered = filtered.slice(0, parseInt(filter.limit));
        }

        return filtered;
    } catch (error) {
        console.error('Error reading activity log:', error);
        return [];
    }
}

/**
 * Get activity statistics
 */
async function getActivityStats() {
    const activities = await getActivityLogs();

    const stats = {
        total: activities.length,
        today: 0,
        week: 0,
        month: 0,
        byType: {},
        byAction: {},
        recentZones: [],
        topUsers: {}
    };

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const weekStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

    const zoneActivity = {};

    activities.forEach(activity => {
        const activityDate = new Date(activity.timestamp);

        // Count by time period
        if (activityDate >= todayStart) stats.today++;
        if (activityDate >= weekStart) stats.week++;
        if (activityDate >= monthStart) stats.month++;

        // Count by type
        stats.byType[activity.type] = (stats.byType[activity.type] || 0) + 1;

        // Count by action
        stats.byAction[activity.action] = (stats.byAction[activity.action] || 0) + 1;

        // Track zone activity
        if (activity.zone) {
            if (!zoneActivity[activity.zone]) {
                zoneActivity[activity.zone] = 0;
            }
            zoneActivity[activity.zone]++;
        }

        // Track users
        const user = activity.user || 'Administrator';
        stats.topUsers[user] = (stats.topUsers[user] || 0) + 1;
    });

    // Get top 5 most active zones
    stats.recentZones = Object.entries(zoneActivity)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([zone, count]) => ({ zone, count }));

    return stats;
}

/**
 * Get activity timeline (last 7 days)
 */
async function getActivityTimeline() {
    const activities = await getActivityLogs();
    const timeline = [];

    const now = new Date();
    for (let i = 6; i >= 0; i--) {
        const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
        const dateStr = date.toISOString().split('T')[0];
        
        const dayActivities = activities.filter(a => {
            const activityDate = new Date(a.timestamp).toISOString().split('T')[0];
            return activityDate === dateStr;
        });

        timeline.push({
            date: dateStr,
            day: date.toLocaleDateString('en-US', { weekday: 'short' }),
            total: dayActivities.length,
            create: dayActivities.filter(a => a.action === 'create').length,
            update: dayActivities.filter(a => a.action === 'update').length,
            delete: dayActivities.filter(a => a.action === 'delete').length,
            reload: dayActivities.filter(a => a.action === 'reload').length
        });
    }

    return timeline;
}

// Activity Log page
router.get('/', async (req, res) => {
    try {
        const activities = await getActivityLogs({ limit: 100 });
        const stats = await getActivityStats();
        const timeline = await getActivityTimeline();

        res.render('activity/index', {
            title: 'Activity Log',
            activities,
            stats,
            timeline
        });
    } catch (error) {
        console.error('Error loading activity log:', error);
        res.status(500).send('Error loading activity log');
    }
});

// API: Get activity logs with filters
router.get('/api/logs', async (req, res) => {
    try {
        const filter = {
            type: req.query.type,
            action: req.query.action,
            zone: req.query.zone,
            limit: req.query.limit || 100
        };

        const activities = await getActivityLogs(filter);
        res.json({
            success: true,
            count: activities.length,
            activities
        });
    } catch (error) {
        console.error('Error fetching activity logs:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API: Get activity statistics
router.get('/api/stats', async (req, res) => {
    try {
        const stats = await getActivityStats();
        const timeline = await getActivityTimeline();

        res.json({
            success: true,
            stats,
            timeline
        });
    } catch (error) {
        console.error('Error fetching activity stats:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// API: Clear activity log (optional - for maintenance)
router.post('/api/clear', async (req, res) => {
    try {
        await fs.writeFile(ACTIVITY_LOG_FILE, '', 'utf8');
        res.json({
            success: true,
            message: 'Activity log cleared successfully'
        });
    } catch (error) {
        console.error('Error clearing activity log:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

module.exports = router;
