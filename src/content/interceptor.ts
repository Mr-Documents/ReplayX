// Injected into MAIN world
// We can't import easily if it's a standalone script in web_accessible_resources, 
// so we define minimal types locally, or crxjs bundles it. We will write it self-contained just in case.

(function() {
  const originalFetch = window.fetch;
  const originalXHR = window.XMLHttpRequest;

  let mode: 'IDLE' | 'RECORD' | 'REPLAY' = 'IDLE';
  let replayEvents: any[] = [];
  let currentReplayIndex = 0;

  window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'replayx-content') {
      if (event.data.action === 'SET_MODE') {
        mode = event.data.mode;
        if (mode === 'REPLAY' && event.data.events) {
          replayEvents = event.data.events.filter((e: any) => e.type === 'Network');
          currentReplayIndex = 0;
          console.log('[ReplayX Interceptor] Network mock data loaded', replayEvents.length);
        }
      }
    }
  });

  // Monkey patch fetch
  window.fetch = async function(...args) {
    if (mode === 'REPLAY') {
      // Find matching mock
      const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] instanceof Request ? args[0].url : '');
      const reqMethod = (args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
      
      console.log(`[ReplayX] Replay mode intercepted fetch: ${reqMethod} ${reqUrl}`);
      
      const mockEvent = replayEvents.find(e => e.method === reqMethod && reqUrl.includes(e.url)); // loose matching for simplicity in MVP
      if (mockEvent) {
        console.log(`[ReplayX] Returning mocked response for: ${reqMethod} ${reqUrl}`);
        return new Response(mockEvent.responseBody, {
          status: mockEvent.responseStatus,
          headers: new Headers(mockEvent.responseHeaders)
        });
      }
      console.warn(`[ReplayX] No mock found for ${reqMethod} ${reqUrl}, passing through.`);
    }

    const t0 = performance.now();
    const response = await originalFetch.apply(this, args);
    const clonedResponse = response.clone();

    if (mode === 'RECORD') {
      try {
        const reqUrl = typeof args[0] === 'string' ? args[0] : (args[0] instanceof Request ? args[0].url : '');
        const reqMethod = (args[1]?.method || (args[0] instanceof Request ? args[0].method : 'GET')).toUpperCase();
        
        let bodyInput = args[1]?.body;
        // simplistic body extraction
        const reqBody = typeof bodyInput === 'string' ? bodyInput : null; 

        const headersObj: Record<string, string> = {};
        clonedResponse.headers.forEach((val, key) => {
          headersObj[key] = val;
        });

        const resBody = await clonedResponse.text();

        window.postMessage({
          source: 'replayx-interceptor',
          type: 'Network',
          timestamp: t0,
          method: reqMethod,
          url: reqUrl,
          requestBody: reqBody,
          responseStatus: response.status,
          responseHeaders: headersObj,
          responseBody: resBody
        }, '*');
      } catch (e) {
        console.error('[ReplayX] Error capturing fetch response', e);
      }
    }

    return response;
  };

  // simplistic XHR patch for MVP
  const setupXHRInterceptor = () => {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...rest: any[]) {
      (this as any)._method = method;
      (this as any)._url = url.toString();
      return originalOpen.apply(this, [method, url, ...rest] as any);
    };

    XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
      if (mode === 'REPLAY') {
         // Full XHR mocking is complex because of event listeners (onload, onreadystatechange).
         // For the MVP, if fetch is handled, we log XHR but if the user uses modern apps, fetch is dominant.
         // We do a very basic mock if possible, otherwise we pass through.
         console.warn('[ReplayX] Replaying XHR is partially supported or might pass through actual network calls.');
         // Just a placeholder. In a real scenario we'd synthesize events.
      }

      if (mode === 'RECORD') {
        const t0 = performance.now();
        this.addEventListener('load', function() {
          try {
            const respHeadersStr = this.getAllResponseHeaders();
            const headersArr = respHeadersStr.trim().split(/[\r\n]+/);
            const headersObj: Record<string, string> = {};
            headersArr.forEach(line => {
              const parts = line.split(': ');
              const header = parts.shift();
              const value = parts.join(': ');
              if (header) headersObj[header] = value;
            });

            window.postMessage({
              source: 'replayx-interceptor',
              type: 'Network',
              timestamp: t0,
              method: (this as any)._method || 'UNKNOWN',
              url: (this as any)._url || 'UNKNOWN',
              requestBody: typeof body === 'string' ? body : null,
              responseStatus: this.status,
              responseHeaders: headersObj,
              responseBody: this.responseText || ''
            }, '*');
          } catch(e) {
            console.error('[ReplayX] Error capturing XHR', e);
          }
        });
      }
      return originalSend.apply(this, [body] as any);
    };
  };

  setupXHRInterceptor();

  console.log('[ReplayX] Interceptor active.');
})();
