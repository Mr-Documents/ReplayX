// Network Interception Layer - Production Version
// Handles fetch and XMLHttpRequest interception for recording and replay

(function() {
  // Guard: Prevent double-initialization
  if ((window as any)._replayx_interceptor_loaded) return;
  (window as any)._replayx_interceptor_loaded = true;

  const originalFetch = window.fetch;
  const originalXHR = window.XMLHttpRequest;

  let mode: 'IDLE' | 'RECORD' | 'REPLAY' = 'IDLE';
  let replayNetworkEvents: any[] = [];
  let replayIndex = 0;
  const consumedEventIds = new Set<string>();

  window.addEventListener('message', (event) => {
    if (event.data && event.data.source === 'replayx-content') {
      if (event.data.action === 'SET_MODE') {
        mode = event.data.mode;
        if (mode === 'REPLAY' && event.data.networkEvents) {
          replayNetworkEvents = event.data.networkEvents;
          replayIndex = 0;
          consumedEventIds.clear();
          console.log('[ReplayX Interceptor] Loaded', replayNetworkEvents.length, 'network events for replay');
        }
      }
    }
  });

  // Enhanced fetch interception
  window.fetch = async function(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

    if (mode === 'REPLAY') {
      // Match on body as well for deterministic replay of mutations (POST/GraphQL)
      const requestBody = await extractRequestBody(input, init);
      
      // Find matching network event for replay
      const mockEvent = findMatchingNetworkEvent(method, url, requestBody);
      
      if (mockEvent) {
        console.log(`[ReplayX] Mocking fetch: ${method} ${url}`);
          // Notify page that a mock was consumed so replayer can wait for network-idle
          try {
            window.postMessage({ source: 'replayx-interceptor', action: 'MOCK_CONSUMED', id: mockEvent.id }, '*');
          } catch (e) {}
        return createMockResponse(mockEvent);
      }
      console.warn(`[ReplayX] No mock found for fetch: ${method} ${url}, passing through`);
    }

    const startTime = performance.now();
    const response = await originalFetch.apply(this, [input, init]);

    if (mode === 'RECORD') {
      try {
        const clonedResponse = response.clone();
        const requestHeaders = extractHeaders(input instanceof Request ? input.headers : init?.headers);
        const requestBody = await extractRequestBody(input, init);

        const responseHeaders: Record<string, string> = {};
        clonedResponse.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });

        const responseBody = await clonedResponse.text();

        // Send network event to content script
        const safeRequestHeaders = sanitizeHeaders(requestHeaders || {});
        const safeResponseHeaders = sanitizeHeaders(responseHeaders || {});

        window.postMessage({
          source: 'replayx-interceptor',
          type: 'Network',
          timestamp: startTime,
          method,
          url,
          requestHeaders: safeRequestHeaders,
          requestBody: sanitizeBody(requestBody),
          responseStatus: response.status,
          responseHeaders: safeResponseHeaders,
          responseBody: sanitizeBody(responseBody)
        }, '*');
      } catch (error) {
        console.error('[ReplayX] Error recording fetch:', error);
      }
    }

    return response;
  };

  // Enhanced XMLHttpRequest interception
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  // Track XHR instances
  const xhrInstances = new WeakMap<XMLHttpRequest, {
    method: string;
    url: string;
    requestHeaders: Record<string, string>;
    requestBody?: string;
    startTime: number;
  }>();

  XMLHttpRequest.prototype.open = function(method: string, url: string | URL, ...args: any[]) {
    const xhr = this as XMLHttpRequest;
    const normalizedUrl = typeof url === 'string' ? url : url.href;

    xhrInstances.set(xhr, {
      method: method.toUpperCase(),
      url: normalizedUrl,
      requestHeaders: {},
      startTime: performance.now()
    });

    return originalOpen.apply(xhr, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.setRequestHeader = function(header: string, value: string) {
    const xhr = this as XMLHttpRequest;
    const instance = xhrInstances.get(xhr);
    if (instance) {
      instance.requestHeaders[header] = value;
    }
    return originalSetRequestHeader.apply(xhr, [header, value]);
  };

  XMLHttpRequest.prototype.send = function(body?: Document | XMLHttpRequestBodyInit | null) {
    const xhr = this as XMLHttpRequest;
    const instance = xhrInstances.get(xhr);

    if (!instance) {
      return originalSend.apply(xhr, [body]);
    }

    // Extract request body
    if (body) {
      if (typeof body === 'string') {
        instance.requestBody = body;
      } else if (body instanceof FormData) {
        // Convert FormData to string representation
        const formData: Record<string, string> = {};
        for (const [key, value] of body.entries()) {
          formData[key] = value.toString();
        }
        instance.requestBody = JSON.stringify(formData);
      } else {
        instance.requestBody = body.toString();
      }
    }

    if (mode === 'REPLAY') {
      // Mock XHR response
      const mockEvent = findMatchingNetworkEvent(instance.method, instance.url, instance.requestBody);
      
      if (mockEvent) {
        console.log(`[ReplayX] Mocking XHR: ${instance.method} ${instance.url}`);
        try {
          window.postMessage({ source: 'replayx-interceptor', action: 'MOCK_CONSUMED', id: mockEvent.id }, '*');
        } catch (e) {}
        mockXHRResponse(xhr, mockEvent);
        return;
      }
      console.warn(`[ReplayX] No mock found for XHR: ${instance.method} ${instance.url}, passing through`);
    }

    if (mode === 'RECORD') {
      // Set up response capture
      const originalOnLoad = xhr.onload;
      const originalOnReadyStateChange = xhr.onreadystatechange;

      xhr.onreadystatechange = function() {
        if (xhr.readyState === XMLHttpRequest.DONE) {
          try {
            const responseHeaders = parseResponseHeaders(xhr.getAllResponseHeaders());

            window.postMessage({
              source: 'replayx-interceptor',
              type: 'Network',
              timestamp: instance.startTime,
              method: instance.method,
              url: instance.url,
              requestHeaders: sanitizeHeaders(instance.requestHeaders || {}),
              requestBody: sanitizeBody(instance.requestBody),
              responseStatus: xhr.status,
              responseHeaders: sanitizeHeaders(responseHeaders || {}),
              responseBody: sanitizeBody(xhr.responseText || '')
            }, '*');
          } catch (error) {
            console.error('[ReplayX] Error recording XHR:', error);
          }
        }

        if (originalOnReadyStateChange) {
          originalOnReadyStateChange.apply(xhr, []);
        }
      };

      xhr.onload = function() {
        if (originalOnLoad) {
          originalOnLoad.apply(xhr, []);
        }
      };
    }

    return originalSend.apply(xhr, [body]);
  };

  // Helper functions
  function findMatchingNetworkEvent(method: string, url: string, body?: any): any {
    const fullUrl = new URL(url, window.location.href).href;
    const isMutation = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(method);
    
    let match = replayNetworkEvents.find(event =>
      !consumedEventIds.has(event.id) && 
      event.method === method && 
      event.url === fullUrl &&
      (!isMutation || !body || event.requestBody === body)
    );

    if (!match) {
      const cleanUrl = fullUrl.split(/[?#]/)[0];
      match = replayNetworkEvents.find(event => {
        if (consumedEventIds.has(event.id)) return false;
        const cleanEventUrl = event.url.split(/[?#]/)[0];
        return event.method === method && 
               cleanEventUrl === cleanUrl &&
               (!isMutation || !body || event.requestBody === body);
      });
    }

    if (match) consumedEventIds.add(match.id);
    return match;
  }

  function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const copy: Record<string, string> = {};
    for (const k of Object.keys(headers || {})) {
      const low = k.toLowerCase();
      if (low === 'authorization' || low === 'cookie' || low === 'set-cookie') continue;
      copy[k] = headers[k];
    }
    return copy;
  }

  function sanitizeBody(body: any): any {
    if (!body) return body;
    try {
      if (typeof body === 'string' && (body.trim().startsWith('{') || body.trim().startsWith('['))) {
        const parsed = JSON.parse(body);
        // Mask common sensitive keys
        const sensitive = ['password', 'card', 'cc', 'cvv', 'token'];
        const maskObj = (obj: any) => {
          if (Array.isArray(obj)) return obj.map(maskObj);
          if (obj && typeof obj === 'object') {
            const out: any = {};
            for (const k of Object.keys(obj)) {
              if (sensitive.includes(k.toLowerCase())) out[k] = '*****';
              else out[k] = maskObj(obj[k]);
            }
            return out;
          }
          return obj;
        };
        return JSON.stringify(maskObj(parsed));
      }
    } catch (e) {}
    return body;
  }

  function createMockResponse(event: any): Response {
    return new Response(event.responseBody, {
      status: event.responseStatus,
      statusText: 'OK',
      headers: event.responseHeaders
    });
  }

  function mockXHRResponse(xhr: XMLHttpRequest, event: any) {
    // Simulate XHR events for mocking
    Object.defineProperty(xhr, 'status', { value: event.responseStatus, writable: false });
    Object.defineProperty(xhr, 'statusText', { value: event.responseStatus >= 400 ? 'Error' : 'OK', writable: false });
    
    // Handle Response based on expected responseType
    let responseValue = event.responseBody;
    if (xhr.responseType === 'json') {
      try {
        responseValue = JSON.parse(event.responseBody);
      } catch (e) {
        console.error('[ReplayX] Failed to parse mock JSON response', e);
      }
    }

    Object.defineProperty(xhr, 'responseText', { value: event.responseBody, writable: false });
    Object.defineProperty(xhr, 'response', { value: responseValue, writable: false });

    // Simulate readyState changes
    Object.defineProperty(xhr, 'readyState', { value: XMLHttpRequest.DONE, writable: false });

    // Mock header methods essential for response parsing logic in libraries like Axios
    xhr.getAllResponseHeaders = function() {
      return Object.entries(event.responseHeaders || {})
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n') + '\r\n';
    };

    xhr.getResponseHeader = function(header: string) {
      const headers = event.responseHeaders || {};
      const key = Object.keys(headers).find(k => k.toLowerCase() === header.toLowerCase());
      return key ? headers[key] : null;
    };

    // Trigger events asynchronously to match real XHR behavior
    setTimeout(() => {
      // Dispatch via event system for addEventListener support
      xhr.dispatchEvent(new Event('readystatechange'));
      if (xhr.onreadystatechange) {
        xhr.onreadystatechange(new Event('readystatechange'));
      }

      xhr.dispatchEvent(new Event('load'));
      if (xhr.onload) {
        xhr.onload(new ProgressEvent('load', { lengthComputable: false, loaded: 0, total: 0 }));
      }
    }, 0);
  }

  function extractHeaders(headers?: HeadersInit): Record<string, string> {
    const result: Record<string, string> = {};
    if (!headers) return result;

    if (headers instanceof Headers) {
      headers.forEach((value, key) => {
        result[key] = value;
      });
    } else if (Array.isArray(headers)) {
      headers.forEach(([key, value]) => {
        result[key] = value;
      });
    } else {
      Object.assign(result, headers);
    }

    return result;
  }

  async function extractRequestBody(input: RequestInfo | URL, init?: RequestInit): Promise<string | undefined> {
    // Handle Request object when init.body is empty (common in many libraries)
    if (input instanceof Request && !init?.body) {
      try {
        const cloned = input.clone();
        return await cloned.text();
      } catch (e) { return undefined; }
    }

    if (init?.body) {
      if (typeof init.body === 'string') return init.body;
      if (init.body instanceof URLSearchParams) return init.body.toString();
      if (init.body instanceof FormData) {
        const data: Record<string, string> = {};
        for (const [key, value] of init.body.entries()) {
          data[key] = value.toString();
        }
        return JSON.stringify(data);
      }
      if (init.body instanceof Blob) {
        return await init.body.text();
      }
      if (init.body instanceof ArrayBuffer) {
        return new TextDecoder().decode(init.body);
      }
    }
    return undefined;
  }

  function parseResponseHeaders(headerString: string): Record<string, string> {
    const headers: Record<string, string> = {};
    const lines = headerString.trim().split(/[\r\n]+/);

    lines.forEach(line => {
      const index = line.indexOf(': ');
      if (index > 0) {
        const key = line.substring(0, index);
        const value = line.substring(index + 2);
        headers[key] = value;
      }
    });

    return headers;
  }

  console.log('[ReplayX] Network interceptor initialized');
})();
