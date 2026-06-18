// Network Interception Layer - Production Version
// Handles fetch and XMLHttpRequest interception for recording and replay

(function() {
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
      // Find matching network event for replay
      const mockEvent = findMatchingNetworkEvent(method, url);
      if (mockEvent) {
        console.log(`[ReplayX] Mocking fetch: ${method} ${url}`);
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
        window.postMessage({
          source: 'replayx-interceptor',
          type: 'Network',
          timestamp: startTime,
          method,
          url,
          requestHeaders,
          requestBody,
          responseStatus: response.status,
          responseHeaders,
          responseBody
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
      const mockEvent = findMatchingNetworkEvent(instance.method, instance.url);
      if (mockEvent) {
        console.log(`[ReplayX] Mocking XHR: ${instance.method} ${instance.url}`);
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
              requestHeaders: instance.requestHeaders,
              requestBody: instance.requestBody,
              responseStatus: xhr.status,
              responseHeaders,
              responseBody: xhr.responseText || ''
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
  function findMatchingNetworkEvent(method: string, url: string): any {
    const fullUrl = new URL(url, window.location.href).href;
    
    // 1. Try exact match first
    let match = replayNetworkEvents.find(event => 
      event.method === method && event.url === fullUrl
    );

    // 2. Fallback to fuzzy match (ignoring query params/hashes)
    if (!match) {
      const cleanUrl = fullUrl.split(/[?#]/)[0];
      match = replayNetworkEvents.find(event => {
        const cleanEventUrl = event.url.split(/[?#]/)[0];
        return event.method === method && cleanEventUrl === cleanUrl;
      });
    }

    return match;
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
    Object.defineProperty(xhr, 'statusText', { value: 'OK', writable: false });
    Object.defineProperty(xhr, 'responseText', { value: event.responseBody, writable: false });
    Object.defineProperty(xhr, 'response', { value: event.responseBody, writable: false });

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
