const fs = require('fs').promises;
const path = require('path');

const ACTIVITY_LOG_FILE = path.join(__dirname, '../data/activity.log');

/**
 * Log an activity
 * @param {Object} activity - Activity data
 * @param {string} activity.type - Type: 'zone', 'record', 'system'
 * @param {string} activity.action - Action: 'create', 'update', 'delete', 'reload', 'view'
 * @param {string} activity.description - Activity description
 * @param {string} [activity.zone] - Zone name (optional)
 * @param {string} [activity.user] - User (optional, defaults to 'Administrator')
 * @param {Object} [activity.details] - Additional details (optional)
 */
async function logActivity(activity) {
    try {
        const logEntry = {
            timestamp: new Date().toISOString(),
            type: activity.type,
            action: activity.action,
            description: activity.description,
            zone: activity.zone || null,
            user: activity.user || 'Administrator',
            details: activity.details || null
        };

        // Ensure data directory exists
        const dataDir = path.join(__dirname, '../data');
        try {
            await fs.access(dataDir);
        } catch {
            await fs.mkdir(dataDir, { recursive: true });
        }

        // Append to log file (one JSON object per line)
        const logLine = JSON.stringify(logEntry) + '\n';
        await fs.appendFile(ACTIVITY_LOG_FILE, logLine, 'utf8');

        console.log(`✓ Activity logged: ${activity.type} - ${activity.action} - ${activity.description}`);
    } catch (error) {
        console.error('Error logging activity:', error);
        // Don't throw error - logging should not break the main flow
    }
}

/**
 * Quick log functions for common operations
 */
const activityLogger = {
    // Zone operations
    zoneCreated: (zoneName, details = {}) => logActivity({
        type: 'zone',
        action: 'create',
        description: `Zone "${zoneName}" created`,
        zone: zoneName,
        details
    }),

    zoneDeleted: (zoneName, details = {}) => logActivity({
        type: 'zone',
        action: 'delete',
        description: `Zone "${zoneName}" deleted`,
        zone: zoneName,
        details
    }),

    zoneViewed: (zoneName) => logActivity({
        type: 'zone',
        action: 'view',
        description: `Zone "${zoneName}" viewed`,
        zone: zoneName
    }),

    // Record operations
    recordCreated: (zoneName, recordName, recordType, details = {}) => logActivity({
        type: 'record',
        action: 'create',
        description: `Record "${recordName}" (${recordType}) created in zone "${zoneName}"`,
        zone: zoneName,
        details: { recordName, recordType, ...details }
    }),

    recordUpdated: (zoneName, recordName, recordType, details = {}) => logActivity({
        type: 'record',
        action: 'update',
        description: `Record "${recordName}" (${recordType}) updated in zone "${zoneName}"`,
        zone: zoneName,
        details: { recordName, recordType, ...details }
    }),

    recordDeleted: (zoneName, recordName, recordType, details = {}) => logActivity({
        type: 'record',
        action: 'delete',
        description: `Record "${recordName}" (${recordType}) deleted from zone "${zoneName}"`,
        zone: zoneName,
        details: { recordName, recordType, ...details }
    }),

    // System operations
    bindReloaded: (details = {}) => logActivity({
        type: 'system',
        action: 'reload',
        description: 'Bind DNS server reloaded',
        details
    }),

    settingsUpdated: (details = {}) => logActivity({
        type: 'system',
        action: 'update',
        description: 'System settings updated',
        details
    }),

    backupCreated: (zoneName, backupPath) => logActivity({
        type: 'system',
        action: 'create',
        description: `Backup created for zone "${zoneName}"`,
        zone: zoneName,
        details: { backupPath }
    }),

    // Custom activity
    custom: (type, action, description, zone = null, details = {}) => logActivity({
        type,
        action,
        description,
        zone,
        details
    })
};

module.exports = {
    logActivity,
    activityLogger
};
