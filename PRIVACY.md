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
   - Non-HttpOnly cookies readable via `document.cookie` at the moment recording
     starts, stored as part of the session's initial state
   - User agent string

   HttpOnly cookies are not readable by any extension content script and are
   never captured.

2. **Local Storage**: All recorded sessions are stored locally in your browser's IndexedDB. No data is sent to external servers.

### Data Sanitization

ReplayX automatically sanitizes sensitive data:

- **Password fields**: Values are masked as `********` before they leave the page
- **Credential-shaped fields**: Inputs whose `name` or `id` matches patterns such
  as pass, card, cvv, ssn, secret, token, pin, otp, iban, or account are masked,
  as is anything with `autocomplete="current-password"`/`cc-*`/`one-time-code`
- **Opt-in masking**: Add `data-replay-mask` to any element to force masking
- **Masking covers both `input` and `change` events**, so a value redacted while
  typing cannot reappear when the field is committed
- **Authorization headers**: `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`
  and similar authentication headers are dropped, never stored
- **Sensitive query parameters**: `token`, `apikey`, `sessionid`, `auth`,
  `password`, `code`, `signature` and similar are masked in URLs on import
- **Request/response bodies**: Credential-shaped keys are masked in both JSON and
  `application/x-www-form-urlencoded` bodies
- **Body size**: Request and response bodies are truncated at 128KB

Masking is best-effort pattern matching, not a guarantee. Review a session before
sharing it, and prefer `data-replay-mask` for anything you know is sensitive.

### Data Retention

- Sessions are stored locally in your browser
- Automatic cleanup deletes sessions older than 30 days
- Maximum of 100 sessions are retained at any time
- You can manually delete sessions at any time through the extension popup

### Data Sharing

- **No external data transmission**: ReplayX does not send any recorded data to external servers
- **Export functionality**: When you export a session, the data is saved to your local machine as a JSON file. You are responsible for the security of exported files
- **Import functionality**: Imported sessions are validated against a schema and
  sanitised before storage. Captured cookies are **stripped entirely** on import,
  so replaying a session someone else exported cannot inject their credentials
  into your browser
- **Export contents**: An exported session may contain cookies captured at
  recording time. Treat exported files as sensitive.

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

- A restrictive Content Security Policy is enforced on extension pages
  (`script-src 'self'; object-src 'self'; connect-src 'self';`)
- The popup renders all session-derived content as text, never as HTML, so
  recorded page content cannot execute in the extension's privileged context
- Messages arriving over the page-visible `window.postMessage` bridge are
  origin-checked and shape-validated before being trusted
- Host permissions are restricted to `http://*/*` and `https://*/*`; no
  `<all_urls>` and no `downloads` permission
- All imported session data is validated against a schema
- TypeScript strict mode and an enforced lint/coverage gate in CI

### Changes to This Policy

We may update this privacy policy from time to time. Significant changes will be reflected in the extension version number and documentation.

### Contact

For questions about this privacy policy or to report security issues, please refer to the project's GitHub repository.

---

**Last Updated**: August 2026
**Version**: 1.0.0
