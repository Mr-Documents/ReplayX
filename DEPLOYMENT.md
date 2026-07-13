# Deployment Guide for ReplayX

This guide covers building, testing, and deploying the ReplayX Chrome extension for production.

## Prerequisites

- Node.js (v18 or higher)
- npm or yarn
- Chrome or Chromium browser for testing
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
   - Check that `dist/manifest.json` exists and is valid
   - Ensure `dist/service_worker.js` is present (not `.ts`)
   - Verify all content scripts are compiled to JavaScript

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

Run the test suite:
```bash
npm run test
```

Run tests with coverage:
```bash
npm run test:coverage
```

## Security Verification

Before deployment, verify:

1. **Manifest Permissions**
   - Host permissions are restricted to `http://*/*` and `https://*/*`
   - No `<all_urls>` permission
   - Content Security Policy is configured

2. **Data Sanitization**
   - Password fields are masked
   - Authorization headers are removed
   - Sensitive query parameters are masked
   - Import validation is enabled

3. **Type Safety**
   - TypeScript strict mode is enabled
   - No TypeScript compilation errors
   - All unused variables are removed

## Chrome Web Store Submission

### Preparation

1. **Update Version**
   - Increment version in `manifest.json`
   - Update version in `package.json`

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
- **Solution**: Run `npm run type-check` to identify issues
- Ensure all dependencies are installed
- Check TypeScript configuration in `tsconfig.json`

**Problem**: Service worker not loading
- **Solution**: Verify `service_worker.js` exists in `dist`
- Check manifest.json references the correct file
- Ensure service worker is configured as a module

### Runtime Issues

**Problem**: Extension not recording
- **Solution**: Check browser console for errors
- Verify content scripts are injected
- Check host permissions in manifest.json

**Problem**: Replay failures
- **Solution**: Verify session data is valid
- Check for DOM mismatches
- Review replay error logs

## Continuous Deployment (Optional)

For automated deployments, consider setting up:

1. **GitHub Actions** for CI/CD
2. **Automated testing** on push
3. **Automated builds** on release tags
4. **Version management** using semantic versioning

Example GitHub Actions workflow:

```yaml
name: Build and Test

on: [push, pull_request]

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
      - run: npm install
      - run: npm run build
      - run: npm run test
```

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

**Last Updated**: January 2026
**Version**: 1.0
