// Main JavaScript for NDash

// Mobile menu functions
function toggleMobileMenu() {
    const sidebar = document.getElementById('sidebar');
    const overlay = document.getElementById('mobile-menu-overlay');

    if (sidebar.classList.contains('-translate-x-full')) {
        // Show menu
        sidebar.classList.remove('-translate-x-full');
        overlay.classList.remove('hidden');
        document.body.style.overflow = 'hidden'; // Prevent background scrolling
    } else {
        // Hide menu
        sidebar.classList.add('-translate-x-full');
        overlay.classList.add('hidden');
        document.body.style.overflow = ''; // Restore scrolling
    }
}

// Close mobile menu when clicking on a nav item
document.addEventListener('DOMContentLoaded', function() {
    // Initialize tooltips
    initTooltips();

    // Auto-hide alerts
    autoHideAlerts();

    // Convert server messages to toasts
    convertServerMessagesToToasts();

    // Confirm delete actions
    initDeleteConfirms();

    // Real-time clock update
    updateClock();
    setInterval(updateClock, 1000);

    // Close mobile menu when clicking nav items on mobile
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        item.addEventListener('click', function() {
            if (window.innerWidth < 1024) { // lg breakpoint
                toggleMobileMenu();
            }
        });
    });
});

function initTooltips() {
    const tooltipElements = document.querySelectorAll('[data-tooltip]');
    tooltipElements.forEach(element => {
        element.setAttribute('title', element.dataset.tooltip);
    });
}

function autoHideAlerts() {
    const alerts = document.querySelectorAll('.alert-auto-hide');
    alerts.forEach(alert => {
        setTimeout(() => {
            alert.style.opacity = '0';
            setTimeout(() => alert.remove(), 300);
        }, 5000);
    });
}

function convertServerMessagesToToasts() {
    // Convert success messages to toasts
    // Target alert divs with text-green-700 (alert style)
    const successAlerts = document.querySelectorAll('.bg-green-50.text-green-700');
    successAlerts.forEach(alert => {
        const message = alert.textContent.trim();
        if (message) {
            toastManager.success(message, 'Success');
            alert.remove(); // Remove the original alert
        }
    });

    // Convert error messages to toasts
    // Target alert divs with text-red-700 (alert style)
    const errorAlerts = document.querySelectorAll('.bg-red-50.text-red-700');
    errorAlerts.forEach(alert => {
        const message = alert.textContent.trim();
        if (message) {
            toastManager.error(message, 'Error');
            alert.remove(); // Remove the original alert
        }
    });

    // Convert warning messages to toasts
    // Target alert divs with text-yellow-700 (alert style)
    const warningAlerts = document.querySelectorAll('.bg-yellow-50.text-yellow-700');
    warningAlerts.forEach(alert => {
        const message = alert.textContent.trim();
        if (message) {
            toastManager.warning(message, 'Warning');
            alert.remove(); // Remove the original alert
        }
    });
}

function initDeleteConfirms() {
    const deleteForms = document.querySelectorAll('form[data-confirm]');
    deleteForms.forEach(form => {
        form.addEventListener('submit', function(e) {
            if (!confirm(this.dataset.confirm || 'Are you sure?')) {
                e.preventDefault();
            }
        });
    });
}

function updateClock() {
    const clockElement = document.getElementById('current-time');
    if (clockElement) {
        const now = new Date();
        clockElement.textContent = now.toLocaleTimeString('en-US', { 
            hour12: true,
            hour: 'numeric',
            minute: '2-digit',
            second: '2-digit'
        });
    }
}

// Zone management functions
function reloadZone(zoneId) {
    if (confirm('Reload this zone configuration?')) {
        // In production, this would call the Bind reload API
        console.log('Reloading zone:', zoneId);
        alert('Zone reload initiated');
    }
}

function validateZoneForm(form) {
    const zoneName = form.querySelector('[name="name"]').value;
    const domainRegex = /^[a-z0-9]+([\-\.]{1}[a-z0-9]+)*\.[a-z]{2,}$/i;
    
    if (!domainRegex.test(zoneName)) {
        alert('Please enter a valid domain name');
        return false;
    }
    
    return true;
}

// Record management functions
function validateRecordForm(form) {
    const recordType = form.querySelector('[name="type"]').value;
    const recordValue = form.querySelector('[name="value"]').value;
    
    // Basic validation based on record type
    switch(recordType) {
        case 'A':
            const ipv4Regex = /^(\d{1,3}\.){3}\d{1,3}$/;
            if (!ipv4Regex.test(recordValue)) {
                alert('Invalid IPv4 address');
                return false;
            }
            break;
        case 'AAAA':
            // Basic IPv6 validation
            if (!recordValue.includes(':')) {
                alert('Invalid IPv6 address');
                return false;
            }
            break;
    }
    
    return true;
}

// Utility functions
function copyToClipboard(text) {
    navigator.clipboard.writeText(text).then(() => {
        showToast('Copied to clipboard!', 'success');
    });
}

// Toast Notification System
class ToastManager {
    constructor() {
        this.container = null;
        this.init();
    }

    init() {
        // Create toast container if it doesn't exist
        if (!document.querySelector('.toast-container')) {
            this.container = document.createElement('div');
            this.container.className = 'toast-container';
            document.body.appendChild(this.container);
        } else {
            this.container = document.querySelector('.toast-container');
        }
    }

    show(message, type = 'info', title = null, duration = 5000) {
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        // Set default titles based on type
        if (!title) {
            switch (type) {
                case 'success':
                    title = 'Success';
                    break;
                case 'error':
                    title = 'Error';
                    break;
                case 'warning':
                    title = 'Warning';
                    break;
                case 'info':
                default:
                    title = 'Info';
                    break;
            }
        }

        // Icon based on type
        const iconClass = this.getIconClass(type);

        toast.innerHTML = `
            <div class="toast-icon">
                <i class="${iconClass}"></i>
            </div>
            <div class="toast-content">
                <div class="toast-title">${title}</div>
                <div class="toast-message">${message}</div>
            </div>
            <button class="toast-close" onclick="toastManager.hide(this.parentElement)">
                <i class="fas fa-times"></i>
            </button>
            <div class="toast-progress" style="width: 100%; animation: progress ${duration}ms linear forwards;"></div>
        `;

        // Add to container
        this.container.appendChild(toast);

        // Trigger animation
        setTimeout(() => {
            toast.classList.add('show', 'animate-in');
        }, 10);

        // Auto hide
        setTimeout(() => {
            this.hide(toast);
        }, duration);

        return toast;
    }

    hide(toast) {
        if (!toast) return;

        toast.classList.remove('show');
        toast.classList.add('animate-out');

        setTimeout(() => {
            if (toast.parentElement) {
                toast.parentElement.removeChild(toast);
            }
        }, 300);
    }

    getIconClass(type) {
        switch (type) {
            case 'success':
                return 'fas fa-check-circle';
            case 'error':
                return 'fas fa-exclamation-circle';
            case 'warning':
                return 'fas fa-exclamation-triangle';
            case 'info':
            default:
                return 'fas fa-info-circle';
        }
    }

    // Convenience methods
    success(message, title = null, duration = 5000) {
        return this.show(message, 'success', title, duration);
    }

    error(message, title = null, duration = 7000) {
        return this.show(message, 'error', title, duration);
    }

    warning(message, title = null, duration = 6000) {
        return this.show(message, 'warning', title, duration);
    }

    info(message, title = null, duration = 5000) {
        return this.show(message, 'info', title, duration);
    }
}

// Global toast manager instance
const toastManager = new ToastManager();

// Legacy function for backward compatibility
function showNotification(message, type = 'info') {
    return toastManager.show(message, type);
}

// Enhanced showToast function
function showToast(message, type = 'info', title = null, duration = null) {
    return toastManager.show(message, type, title, duration);
}

// Quick toast functions for common use cases
function showSuccessToast(message, title = 'Success') {
    return toastManager.success(message, title);
}

function showErrorToast(message, title = 'Error') {
    return toastManager.error(message, title);
}

function showWarningToast(message, title = 'Warning') {
    return toastManager.warning(message, title);
}

function showInfoToast(message, title = 'Info') {
    return toastManager.info(message, title);
}
