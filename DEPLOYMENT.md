# Deployment Guide for ReplayX

This guide covers building, testing, and deploying the ReplayX Chrome extension for production.

## Prerequisites

- Node.js 20.19 or higher (see `.nvmrc`; the toolchain requires it)
- npm
- Chrome or Chromium 116+ for testing
- Chrome Web Store Developer Account (for publishing)

## Development Setup

1. **Install Dependencies**
   ```bash
   npm install
   ```

2. **Development Build**
   ```bash
   npm run dev
   ```
   This starts the Vite dev server with hot-reload for the extension.

3. **Load Extension in Chrome**
   - Navigate to `chrome://extensions/`
   - Enable "Developer mode"
   - Click "Load unpacked"
   - Select the `dist` folder

## Production Build

1. **Build for Production**
   ```bash
   npm run build
   ```
   This creates an optimized production build in the `dist` folder.

2. **Build Configuration**
   - TypeScript strict mode is enabled
   - Content Security Policy is enforced
   - Service worker is configured as a module
   - All assets are minified and optimized

3. **Verify Build**
   - `dist/manifest.json` exists, is Manifest V3, and lists a `background.service_worker`
   - The bundler rewrites `manifest.json` paths to hashed filenames; the built
     manifest must not still reference any `.ts` file
   - Exactly one content script entry declares `"world": "MAIN"` (the interceptor)
   - `dist/favicon.svg` exists, since the manifest icons resolve to it

   CI performs these checks automatically; see `.github/workflows/ci.yml`.

## Testing Before Deployment

### Manual Testing Checklist

- [ ] Load extension in Chrome (developer mode)
- [ ] Test recording on a simple webpage
- [ ] Test replay functionality
- [ ] Test session export/import
- [ ] Test session deletion
- [ ] Verify data sanitization (check recorded sessions for sensitive data)
- [ ] Test on different websites (HTTP and HTTPS)
- [ ] Test error handling (try recording on invalid pages)
- [ ] Verify memory management (record a long session)
- [ ] Check browser console for errors

### Automated Testing

```bash
npm run verify   # typecheck + lint + tests with coverage + production build
```

Individual steps:

```bash
npm run typecheck
npm run lint
npm run test:run
npm run test:coverage   # fails the build if coverage regresses below threshold
```

## Security Verification

Before deployment, verify:

1. **Manifest Permissions**
   - Host permissions are restricted to `http://*/*` and `https://*/*`
   - No `<all_urls>` permission
   - No `downloads` permission: export builds the file in the popup instead
   - `extension_pages` CSP is `script-src 'self'; object-src 'self'; connect-src 'self';`
     (the popup makes no outbound requests, so `connect-src` stays closed)

2. **Data Sanitization**
   - Password and credential-shaped fields are masked at capture time, on both
     `input` and `change`
   - Authorization-style headers are dropped by the interceptor
   - Credential-shaped JSON and form-encoded body fields are masked
   - Sensitive query parameters are masked on import
   - Imported sessions have `initialState.cookies` and `metadata.cookiesCaptured`
     stripped before storage

3. **Extension-page XSS**
   - The popup renders every recorded value with `createElement` + `textContent`.
     Any change that introduces `innerHTML` on session-derived data is a
     security regression: recorded page text is attacker-controlled.

4. **Type Safety**
   - TypeScript strict mode, `noUncheckedIndexedAccess`, and `noImplicitReturns`
   - `npm run typecheck` and `npm run lint` both clean

## Chrome Web Store Submission

### Preparation

1. **Update Version**
   - Increment `version` in `manifest.json`
   - Keep `version` in `package.json` in sync

2. **Package Extension**
   - Build production version: `npm run build`
   - Zip the `dist` folder
   - Name the zip file: `replayx-v1.0.0.zip` (with version number)

3. **Store Listing Assets**
   - Prepare icon (128x128, 48x48, 16x16)
   - Create screenshots (1280x800 or 640x400)
   - Write detailed description
   - Prepare privacy policy (use PRIVACY.md)

### Submission Process

1. Go to [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole)
2. Click "New Item"
3. Upload the zip file
4. Fill in store listing:
   - Name: ReplayX
   - Description: Deterministic session recorder and replay tool
   - Category: Developer Tools
   - Language: English
5. Upload privacy policy content
6. Upload screenshots
7. Set pricing (Free)
8. Submit for review

### Review Process

- Typical review time: 1-3 business days
- Google may request changes based on their policies
- Monitor email for review status updates

## Post-Deployment Monitoring

### Error Tracking

Monitor the extension for:
- Installation failures
- Runtime errors (check browser console)
- User feedback (Chrome Web Store reviews)
- Performance issues

### Updates

When releasing updates:

1. Increment version number
2. Update CHANGELOG.md
3. Test thoroughly
4. Submit new version to Chrome Web Store
5. Monitor adoption and feedback

## Troubleshooting

### Build Issues

**Problem**: TypeScript compilation errors
- **Solution**: Run `npm run typecheck` to identify issues
- Ensure dependencies are installed and Node is 20.19+

**Problem**: `Cannot find native binding` from the bundler
- **Solution**: npm's optional-dependency bug. Remove `node_modules` and run
  `npm install` again with the Node version from `.nvmrc`

**Problem**: Service worker not loading
- **Solution**: Confirm `dist/service-worker-loader.js` exists and that
  `dist/manifest.json` points at it with `"type": "module"`

**Problem**: Recording state lost after leaving the popup open a while
- **Solution**: Expected only if state is being held in worker memory. State
  belongs in `chrome.storage.session` (`src/background/state.ts`) and flushed
  events go straight to IndexedDB

### Runtime Issues

**Problem**: Extension not recording
- **Solution**: Check browser console for errors
- Verify content scripts are injected
- Check host permissions in manifest.json

**Problem**: Replay failures
- **Solution**: Verify session data is valid
- Check for DOM mismatches
- Review replay error logs

## Continuous Integration

Automated builds on release tags and Chrome Web Store upload via the
`chrome-webstore-upload` API remain a future addition.

CI is already configured in [.github/workflows/ci.yml](.github/workflows/ci.yml).
On every push and pull request to `main` it runs, across Node 20.19 / 22 / 24:

- `npm run typecheck`
- `npm run lint`
- `npm run test:coverage` (coverage thresholds enforced)
- `npx vite build`, followed by a structural validation of `dist/manifest.json`

A separate job runs `npm audit --audit-level=high`. Coverage and the built
extension are uploaded as artefacts, so a release candidate can be downloaded
straight from the workflow run.

## Support and Maintenance

- Monitor Chrome Web Store reviews
- Respond to user issues promptly
- Keep dependencies updated
- Follow Chrome extension best practices
- Stay informed about Chrome Web Store policy changes

## Resources

- [Chrome Extension Documentation](https://developer.chrome.com/docs/extensions/)
- [Chrome Web Store Developer Policies](https://chrome.google.com/webstore/developer/policy)
- [Manifest V3 Migration Guide](https://developer.chrome.com/docs/extensions/mv3/intro/)
- [Vite Documentation](https://vitejs.dev/)

---

**Last Updated**: August 2026
**Version**: 1.0.0
