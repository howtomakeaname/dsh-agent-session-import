    function fmt(text, params) {
      if (params === undefined) return text;
      return text.replace(/\{(\w+)\}/g, (whole, key) => (params[key] === undefined ? whole : String(params[key])));
    }

    /** Format a millisecond timestamp as a compact local date-time. */
    function formatTime(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '';
      try {
        const d = new Date(value);
        const pad = (n) => String(n).padStart(2, '0');
        return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      } catch {
        return '';
      }
    }

    // ── host RPC ────────────────────────────────────────────────────────────
    /**
     * Resolve one Host endpoint URL relative to the page. Both the Web GUI
     * (http origin) and the Desktop carrier (`dsh-app://app/`, whose protocol
     * handler proxies non-shell paths to the Host server) accept this form.
     * @param endpoint - endpoint name registered by the Host half.
     * @returns absolute URL string.
     */
    function endpointUrl(endpoint) {
      const base = typeof document !== 'undefined' && typeof document.baseURI === 'string' ? document.baseURI : 'http://localhost/';
      return new URL(`${ROUTE_PREFIX.replace(/^\/+/, '')}/${endpoint}`, base).toString();
    }

    /**
     * Call one Host JSON endpoint.
     * @param endpoint - endpoint name registered by the Host half.
     * @param payload - JSON payload.
     * @returns the endpoint value.
     */
    async function rpcCall(endpoint, payload) {
      const response = await fetch(endpointUrl(endpoint), {
        method: 'POST',
        // The custom header lets the Host route distinguish this same-origin
        // plugin caller even when a Desktop proxy rewrites the Origin header.
        headers: { 'content-type': 'application/json', 'x-dsh-agent-session-import': '1' },
        body: JSON.stringify(payload === undefined ? {} : payload),
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        throw new Error(`HTTP ${response.status}${detail === '' ? '' : `: ${detail.slice(0, 200)}`}`);
      }
      let body;
      try {
        body = await response.json();
      } catch {
        throw new Error('Host returned a non-JSON response');
      }
      if (body === null || typeof body !== 'object' || body.ok !== true) {
        const failure = body?.error ?? {};
        throw new Error(typeof failure.message === 'string' ? failure.message : 'import request failed');
      }
      return body.value;
    }
