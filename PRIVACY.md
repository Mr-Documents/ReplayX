# Privacy Policy for ReplayX

## Data Collection

ReplayX is a deterministic web replay and debug Chrome extension that records user interactions and network requests for session replay and debugging purposes.

### What Data We Collect

1. **Session Recordings**: When you record a session, ReplayX captures:
   - User interactions (clicks, scrolls, inputs, form submissions)
   - DOM mutations (changes to the page structure)
   - Network requests (URLs, method, headers, and response status)
   - Page navigation events
   - Initial browser state (localStorage, sessionStorage, viewport size)
   - User agent string

2. **Local Storage**: All recorded sessions are stored locally in your browser's IndexedDB. No data is sent to external servers.

### Data Sanitization

ReplayX automatically sanitizes sensitive data:

- **Password fields**: Values are masked as `********`
- **Credit card fields**: Fields with names containing "card" are masked
- **Authorization headers**: Headers like `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, and other authentication tokens are removed
- **Sensitive query parameters**: Parameters like `token`, `apikey`, `sessionid`, `auth`, `password` are masked in URLs
- **Request/Response bodies**: Sensitive keys in JSON payloads (password, token, secret, apikey, etc.) are masked

### Data Retention

- Sessions are stored locally in your browser
- Automatic cleanup deletes sessions older than 30 days
- Maximum of 100 sessions are retained at any time
- You can manually delete sessions at any time through the extension popup

### Data Sharing

- **No external data transmission**: ReplayX does not send any recorded data to external servers
- **Export functionality**: When you export a session, the data is saved to your local machine as a JSON file. You are responsible for the security of exported files
- **Import functionality**: When you import a session, the data is validated and sanitized before being stored

### Third-Party Services

ReplayX does not use any third-party analytics, tracking, or data processing services.

### Your Rights

You have the right to:
- Access all recorded sessions through the extension popup
- Export sessions for backup or sharing
- Delete individual sessions
- Clear all data by uninstalling the extension
- Review and modify the source code (open source)

### Security Measures

- Content Security Policy (CSP) is enforced to prevent XSS attacks
- Host permissions are restricted to `http://*/*` and `https://*/*`
- All imported session data is validated against a schema
- Sensitive data is automatically sanitized during recording
- TypeScript strict mode is enabled for type safety

### Changes to This Policy

We may update this privacy policy from time to time. Significant changes will be reflected in the extension version number and documentation.

### Contact

For questions about this privacy policy or to report security issues, please refer to the project's GitHub repository.

---

**Last Updated**: January 2026
**Version**: 1.0
