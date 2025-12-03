# Toast Notification System

The NDash application now includes a comprehensive toast notification system for better user feedback.

## Features

- **4 notification types**: Success, Error, Warning, Info
- **Auto-dismiss**: Notifications automatically disappear after a configurable duration
- **Progress bar**: Visual indicator showing remaining time
- **Smooth animations**: Slide-in and slide-out animations
- **Manual close**: Users can close notifications early
- **Server message conversion**: Automatically converts server-side flash messages to toasts

## Usage

### JavaScript API

```javascript
// Basic usage
showToast('Message here', 'success');

// With custom title and duration
showToast('Operation completed!', 'success', 'Success', 3000);

// Convenience functions
showSuccessToast('Data saved successfully!');
showErrorToast('Failed to save data');
showWarningToast('Please check your input');
showInfoToast('New updates available');
```

### Server-Side Integration

The system automatically converts existing server flash messages to toasts:

```javascript
// In your route handlers
res.redirect('/page?success=' + encodeURIComponent('Operation successful'));
res.redirect('/page?error=' + encodeURIComponent('Operation failed'));
res.redirect('/page?warning=' + encodeURIComponent('Warning message'));
res.redirect('/page?info=' + encodeURIComponent('Info message'));
```

### CSS Classes

The toast system uses these CSS classes:
- `.toast-container` - Container for all toasts
- `.toast` - Individual toast element
- `.toast-success` - Success toast styling
- `.toast-error` - Error toast styling
- `.toast-warning` - Warning toast styling
- `.toast-info` - Info toast styling

## Configuration

### Duration Settings
- Success: 5000ms (5 seconds)
- Error: 7000ms (7 seconds)
- Warning: 6000ms (6 seconds)
- Info: 5000ms (5 seconds)

### Customization

To customize the toast system, modify:
- `/public/css/style.css` - Toast styling
- `/public/js/main.js` - Toast behavior and timing

## Test Page

Visit `/test-toast` to test the toast notification system interactively.

## Migration from Alert Boxes

The system automatically converts existing alert boxes (`.bg-green-50`, `.bg-red-50`, etc.) to toast notifications on page load, providing a seamless upgrade path.